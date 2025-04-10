// @ts-check
import type { Request, Response } from 'express';
import { z } from 'zod';

import * as sqldb from '@prairielearn/postgres';

import { redirectToTermsPageIfNeeded } from '../ee/lib/terms.js';
import { clearCookie } from '../lib/cookie.js';

import { config } from './config.js';
import { InstitutionSchema, UserSchema } from './db-types.js';
import { isEnterprise } from './license.js';
import { HttpRedirect } from './redirect.js';

const sql = sqldb.loadSqlEquiv(import.meta.url);

interface LoadUserOptions {
  /** Redirect after processing? */
  redirect?: boolean;
}

export interface LoadUserAuth {
  uid?: string;
  uin?: string | null;
  name?: string | null;
  email?: string | null;
  provider: string;
  /** If present, skip the users_select_or_insert call */
  user_id?: number | string;
  institution_id?: number | string | null;
}

export async function loadUser(
  req: Request,
  res: Response,
  authnParams: LoadUserAuth,
  optionsParams: LoadUserOptions = {},
) {
  const options = { redirect: false, ...optionsParams };

  let user_id: number | string;
  if (authnParams.user_id !== undefined) {
    user_id = authnParams.user_id;
  } else {
    const params = [
      authnParams.uid,
      authnParams.name,
      authnParams.uin,
      authnParams.email,
      authnParams.provider,
      authnParams.institution_id,
    ];

    const userSelectOrInsertRes = await sqldb.callAsync('users_select_or_insert', params);

    user_id = userSelectOrInsertRes.rows[0].user_id;
    const { result, user_institution_id } = userSelectOrInsertRes.rows[0];
    if (result === 'invalid_authn_provider') {
      throw new HttpRedirect(
        `/pl/login?unsupported_provider=true&institution_id=${user_institution_id}`,
      );
    }
  }

  const selectedUser = await sqldb.queryOptionalRow(
    sql.select_user,
    { user_id },
    z.object({
      user: UserSchema,
      institution: InstitutionSchema,
      is_administrator: z.boolean(),
      news_item_notification_count: z.number(),
    }),
  );

  if (!selectedUser) {
    throw new Error('user not found with user_id ' + user_id);
  }

  // The session store will pick this up and store it in the `user_sessions.user_id` column.
  req.session.user_id = user_id;

  // Our authentication middleware will read this value.
  req.session.authn_provider_name = authnParams.provider;

  // After explicitly authenticating, clear the cookie that disables
  // automatic authentication.
  if (req.cookies.pl_disable_auto_authn || req.cookies.pl2_disable_auto_authn) {
    clearCookie(res, ['pl_disable_auto_authn', 'pl2_disable_auto_authn']);
  }

  if (options.redirect) {
    let redirUrl = config.homeUrl;
    if ('pl2_pre_auth_url' in req.cookies) {
      redirUrl = req.cookies.pl2_pre_auth_url;
      clearCookie(res, ['preAuthUrl', 'pl2_pre_auth_url']);
    }

    // Potentially prompt the user to accept the terms before redirecting them.
    if (isEnterprise()) {
      await redirectToTermsPageIfNeeded(res, selectedUser.user, req.ip, redirUrl);
    }

    res.redirect(redirUrl);
    return;
  }

  // If we fall-through here, set the res.locals.authn_user variables (middleware)

  res.locals.authn_user = selectedUser.user;
  res.locals.authn_institution = selectedUser.institution;
  res.locals.authn_provider_name = authnParams.provider;
  res.locals.authn_is_administrator = selectedUser.is_administrator;

  const defaultAccessType = config.devMode ? 'active' : 'inactive';
  const accessType = req.cookies.pl2_access_as_administrator || defaultAccessType;
  res.locals.access_as_administrator = accessType === 'active';
  res.locals.is_administrator =
    res.locals.authn_is_administrator && res.locals.access_as_administrator;

  res.locals.is_institution_administrator =
    res.locals.is_administrator ||
    (await sqldb.queryRow(
      sql.select_is_institution_admin,
      {
        institution_id: res.locals.authn_institution.id,
        user_id: res.locals.authn_user.user_id,
      },
      z.boolean(),
    ));

  res.locals.news_item_notification_count = selectedUser.news_item_notification_count;
}
