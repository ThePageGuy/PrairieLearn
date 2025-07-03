import { Router } from 'express';
import asyncHandler from 'express-async-handler';
import { OAuth2Client } from 'google-auth-library';

import { HttpStatusError } from '@prairielearn/error';
import { config } from '../../lib/config.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const providerParam = req.query.provider ?? 'google';
    if (typeof providerParam !== 'string') {
      throw new HttpStatusError(400, 'Invalid provider');
    }

    const provider = providerParam.toLowerCase();

    switch (provider) {
      case 'google': {
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

        const url = oauth2Client.generateAuthUrl({
          access_type: 'online',
          scope: ['openid', 'profile', 'email'],
          prompt: 'select_account',
          // TODO: Add `state` parameter to prevent CSRF
        });

        return res.redirect(url);
      }

      case 'keycloak': {
        // Hardcoded Keycloak credentials (from your admin panel)
        const keycloakClientId = 'prairielearn';
        const keycloakRedirectUri = 'http://localhost:3000/pl/oauth2callback?provider=keycloak';
        const keycloakAuthUrl = 'http://localhost:8080/realms/WWU/protocol/openid-connect/auth';

        // Construct Keycloak OAuth2 URL
        const params = new URLSearchParams({
          client_id: keycloakClientId,
          response_type: 'code',
          scope: 'openid profile email',
          redirect_uri: keycloakRedirectUri,
          // TODO: Add `state` for CSRF protection
        });

        const authUrl = `${keycloakAuthUrl}?${params.toString()}`;
        return res.redirect(authUrl);
      }

      default:
        throw new HttpStatusError(400, `Unsupported provider: ${provider}`);
    }
  }),
);

export default router;
