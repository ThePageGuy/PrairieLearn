import { Router } from 'express';
import asyncHandler from 'express-async-handler';
import { OAuth2Client } from 'google-auth-library';
import axios from 'axios';

import { HttpStatusError } from '@prairielearn/error';
import { logger } from '@prairielearn/logger';
import * as Sentry from '@prairielearn/sentry';

import * as authnLib from '../../lib/authn.js';
import { config } from '../../lib/config.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res, _next) => {
    const provider = (req.query.provider as string)?.toLowerCase() || 'google';

    const code = req.query.code;
    if (!code || typeof code !== 'string') {
      throw new Error('Missing or invalid "code" query parameter for authCallbackOAuth2');
    }

    // FIXME: should check req.query.state to avoid CSRF

    let idToken: string | undefined;
    let identity: any;

    if (provider === 'google') {
      if (
        !config.hasOauth ||
        !config.googleClientId ||
        !config.googleClientSecret ||
        !config.googleRedirectUrl
      ) {
        throw new HttpStatusError(404, 'Google login is not enabled');
      }

      const oauth2Client = new OAuth2Client(
        config.googleClientId,
        config.googleClientSecret,
        config.googleRedirectUrl,
      );

      logger.verbose('Got Google auth with code: ' + code);

      const { tokens } = await oauth2Client.getToken(code).catch((err) => {
        if (err?.response) {
          const scope = Sentry.getCurrentScope();
          scope.setContext('OAuth', {
            code: err.code,
            data: err.response.data,
          });
        }
        throw err;
      });

      idToken = tokens.id_token as string;
      if (!idToken) throw new Error('Missing id_token in Google auth response');

    } else if (provider === 'keycloak') {
      logger.verbose('Got Keycloak auth with code: ' + code);

      const tokenResponse = await axios.post(
        'http://localhost:8080/realms/WWU/protocol/openid-connect/token',
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'prairielearn',
          client_secret: 'mD5W5yHXvt1ab20FyFhA5fwpmO24hlaS',
          code,
          redirect_uri: 'http://localhost:3000/pl/oauth2callback?provider=keycloak',
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      idToken = tokenResponse.data.id_token;
      if (!idToken) throw new Error('Missing id_token in Keycloak auth response');

    } else {
      throw new Error(`Unsupported OAuth2 provider: ${provider}`);
    }

    // Decode JWT and extract identity
    const parts = idToken.split('.');
    if (parts.length < 2) throw new Error('Invalid JWT format in id_token');
    identity = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    logger.verbose(`Got ${provider} auth identity: ` + JSON.stringify(identity));

    if (!identity.email) throw new Error(`${provider} auth response missing email`);

    const authnParams = {
      uid: identity.email,
      name: identity.name || identity.preferred_username || identity.email,
      uin: identity.sub,
      email: identity.email,
      provider: provider === 'keycloak' ? 'Keycloak' : 'Google',
    };

    await authnLib.loadUser(req, res, authnParams, { redirect: true });
  }),
);

export default router;
