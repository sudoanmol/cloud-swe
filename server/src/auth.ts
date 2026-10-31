/**
 * Path: server/src/auth.ts
 * Used by: server/src/index.ts.
 * Purpose: Better Auth sign-in through the GitHub App, for one GitHub account only. Sessions live in the Credentials DO.
 */
import { setTimeout } from 'node:timers/promises';

import { AuthToken } from '@cloud-swe/protocol/credentials';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

import type { Env } from './env.ts';
import { apiError } from './errors.ts';
import { gitIdentity, githubProfile } from './git/github.ts';

const BASE_PATH = '/v1/auth';

const SignInRedirect = z.object({ url: z.url() });

// Long enough to outlast the refusal windows measured live (2026-10-30): 15 to 55 seconds, in about a quarter of tries.
const EXCHANGE_ATTEMPTS = 19;
const EXCHANGE_RETRY_MS = 5000;

type Configured = Env & {
  BETTER_AUTH_SECRET: string;
  GITHUB_ALLOWED_USER_ID: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  PUBLIC_URL: string;
};

const configured = (env: Env): env is Configured =>
  Boolean(
    env.BETTER_AUTH_SECRET &&
    env.GITHUB_ALLOWED_USER_ID &&
    env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET &&
    env.GITHUB_APP_PRIVATE_KEY &&
    env.PUBLIC_URL,
  );

function createAuth(env: Configured) {
  const credentials = () => env.CREDENTIALS.get(env.CREDENTIALS.idFromName('personal'));

  return betterAuth({
    baseURL: env.PUBLIC_URL,
    basePath: BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    secondaryStorage: {
      get: (key) => credentials().authGet(key),
      set: (key, value, ttl) => credentials().authSet(key, value, ttl),
      delete: (key) => credentials().authDelete(key),
      getAndDelete: (key) => credentials().authGetAndDelete(key),
      increment: (key, ttl) => credentials().authIncrement(key, ttl),
    },
    session: { expiresIn: 30 * 24 * 60 * 60 },
    // Better Auth drops a profile field marked `input: false`, so this stays settable; only the allowed account has a session.
    user: { additionalFields: { githubId: { type: 'string' } } },
    // Only OAuth state goes in a cookie. GitHub's user token is used once below and never kept.
    account: { storeStateStrategy: 'cookie', storeAccountCookie: false },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    plugins: [bearer()],
    socialProviders: {
      github: {
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        // The one place an account is accepted: anyone else gets no user and no session.
        async getUserInfo(tokens) {
          if (!tokens.accessToken) return null;
          const profile = await githubProfile(tokens.accessToken).catch(() => undefined);

          if (!profile || String(profile.id) !== env.GITHUB_ALLOWED_USER_ID) return null;
          const identity = gitIdentity(profile);
          await credentials().setGitHubIdentity(identity);

          return {
            user: {
              name: identity.name,
              email: identity.email,
              emailVerified: true,
              githubId: String(profile.id),
            },
            data: profile,
          };
        },
      },
    },
  });
}

let instance: ReturnType<typeof createAuth> | undefined;

/** A Worker's bindings don't change while its isolate lives, so one instance serves every request. */
const auth = (env: Configured) => (instance ??= createAuth(env));

/** The session, only when it still belongs to the allowed account; changing the ID locks out older sessions. */
async function allowedSession(env: Configured, request: Request) {
  const session = await auth(env).api.getSession({ headers: request.headers });

  return session?.user.githubId === env.GITHUB_ALLOWED_USER_ID ? session : null;
}

export async function requireSignIn(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  if (!configured(c.env)) return apiError('api_not_configured');

  if (!(await allowedSession(c.env, c.req.raw))) return apiError('unauthorized');

  await next();
}

/**
 * Open GET /v1/auth/login in a browser. GitHub then returns to /v1/auth/token, which shows the token a client sends
 * as `Authorization: Bearer <token>`. Better Auth serves the rest of /v1/auth/*, such as the callback and sign-out.
 */
export function authRoutes(app: Hono<{ Bindings: Env }>) {
  app.get(`${BASE_PATH}/login`, async (c) => {
    if (!configured(c.env)) return apiError('api_not_configured');

    const response = await auth(c.env).api.signInSocial({
      body: { provider: 'github', callbackURL: `${c.env.PUBLIC_URL}${BASE_PATH}/token` },
      asResponse: true,
    });

    const headers = new Headers(response.headers);
    headers.set('Location', SignInRedirect.parse(await response.json()).url);
    headers.delete('Content-Type');

    return new Response(null, { status: 302, headers });
  });

  app.get(`${BASE_PATH}/token`, async (c) => {
    if (!configured(c.env)) return apiError('api_not_configured');
    const session = await allowedSession(c.env, c.req.raw);

    if (!session) return apiError('unauthorized');
    c.header('Cache-Control', 'no-store');

    return c.json(AuthToken.parse({ token: session.session.token }));
  });

  // GitHub refuses the Worker's code exchange with a 429 for short windows, before using the code, and Better Auth
  // reports that as invalid_code. The state is still in the request's cookie, so the same callback can simply run again.
  // ponytail: Better Auth hides the status, so a truly bad code also waits out every attempt before its error page.
  app.get(`${BASE_PATH}/callback/github`, async (c) => {
    if (!configured(c.env)) return apiError('api_not_configured');

    for (let attempt = 1; ; attempt++) {
      const response = await auth(c.env).handler(c.req.raw);

      if (attempt === EXCHANGE_ATTEMPTS || !response.headers.get('Location')?.includes('error=invalid_code')) {
        return response;
      }

      await setTimeout(EXCHANGE_RETRY_MS);
    }
  });

  app.on(['GET', 'POST'], `${BASE_PATH}/*`, (c) =>
    configured(c.env) ? auth(c.env).handler(c.req.raw) : apiError('api_not_configured'),
  );
}
