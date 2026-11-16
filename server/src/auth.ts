/**
 * Path: server/src/auth.ts
 * Used by: server/src/index.ts.
 * Purpose: Better Auth sign-in through the GitHub App, for one GitHub account only, handed to a browser or, with PKCE, to the app. Sessions live in the Credentials DO.
 */

import { createHash, randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

import {
  APP_REDIRECT_URI,
  AppSignInQuery,
  AuthToken,
  ExchangeSignInCodeRequest,
  LoginQuery,
  SIGN_IN_CODE_TTL_SECONDS,
} from '@cloud-swe/protocol/credentials';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { credentialsStub, type Env, publicUrl } from './env.ts';
import { apiError } from './errors.ts';
import { githubProfile, gitIdentity } from './github.ts';
import { sameSecret } from './sandbox/egress.ts';

const BASE_PATH = '/v1/auth';

/**
 * Where Better Auth sends an app sign-in once GitHub accepts it. No browser ever loads it: the GitHub callback below
 * turns that redirect into the app's. It travels inside Better Auth's encrypted state cookie, so the browser can
 * neither read nor change the challenge it carries.
 */
const APP_CALLBACK_PATH = `${BASE_PATH}/app-callback`;

const SignInRedirect = z.object({ url: z.url() });

// Long enough to outlast the refusal windows measured live (2026-10-30): 15 to 55 seconds, in about a quarter of tries.
const EXCHANGE_ATTEMPTS = 19;
const EXCHANGE_RETRY_MS = 5000;

const REQUIRED = [
  'BETTER_AUTH_SECRET',
  'GITHUB_ALLOWED_USER_ID',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'PUBLIC_URL',
] satisfies (keyof Env)[];

type Configured = Env & Required<Pick<Env, (typeof REQUIRED)[number]>>;

const configured = (env: Env): env is Configured => REQUIRED.every((name) => Boolean(env[name]));

/** Every route behind it needs sign-in set up, so an unset secret is one clear error instead of a failure later. */
export async function requireAuthSetup(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  if (!configured(c.env)) return apiError('api_not_configured');

  await next();

  return undefined;
}

function createAuth(env: Configured) {
  const credentials = () => credentialsStub(env);

  return betterAuth({
    baseURL: publicUrl(env),
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

/** requireAuthSetup runs before every route that signs in, so this only narrows the type. */
function setUp(env: Env): Configured {
  if (!configured(env)) throw new Error('Sign-in is not set up');

  return env;
}

/** A Worker's bindings don't change while its isolate lives, so one instance serves every request. */
const auth = (env: Env) => (instance ??= createAuth(setUp(env)));

/** The session, only when it still belongs to the allowed account; changing the ID locks out older sessions. */
async function allowedSession(env: Env, headers: Headers) {
  const session = await auth(env).api.getSession({ headers });

  return session?.user.githubId === setUp(env).GITHUB_ALLOWED_USER_ID ? session : null;
}

export async function requireSignIn(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  if (!(await allowedSession(c.env, c.req.raw.headers))) return apiError('unauthorized');

  await next();

  return undefined;
}

// GitHub refuses the Worker's code exchange with a 429 for short windows, before using the code, and Better Auth
// reports that as invalid_code. The state is still in the request's cookie, so the same callback can simply run again.
// ponytail: Better Auth hides the status, so a truly bad code also waits out every attempt before its error page.
async function githubCallback(env: Env, request: Request) {
  for (let attempt = 1; ; attempt++) {
    const response = await auth(env).handler(request);
    const location = response.headers.get('Location');
    const refused = location !== null && new URL(location, request.url).searchParams.get('error') === 'invalid_code';

    if (attempt === EXCHANGE_ATTEMPTS || !refused) return response;

    await setTimeout(EXCHANGE_RETRY_MS);
  }
}

/**
 * Turns Better Auth's successful redirect to APP_CALLBACK_PATH into the app's redirect with a one-time code for the
 * session it just created. The session cookie is read back through the same allowed-account check as every request,
 * and is not passed on: the app holds the only copy of the session, not the sign-in sheet's browser.
 */
async function appRedirect(env: Env, signedIn: Response, callback: URL) {
  const challenge = AppSignInQuery.shape.code_challenge.safeParse(callback.searchParams.get('code_challenge'));

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const session = await allowedSession(env, new Headers({ cookie }));

  if (!challenge.success || !session) return apiError('unauthorized');
  const code = randomBytes(32).toString('base64url');
  await credentialsStub(env).storeSignInCode(code, {
    codeChallenge: challenge.data,
    token: session.session.token,
    expiresAt: Date.now() + SIGN_IN_CODE_TTL_SECONDS * 1000,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: `${APP_REDIRECT_URI}?${new URLSearchParams({ code })}`, 'Cache-Control': 'no-store' },
  });
}

/**
 * Open GET /v1/auth/login in a browser. GitHub then returns to /v1/auth/token, which shows the token a client sends
 * as `Authorization: Bearer <token>`. The app adds a PKCE challenge to the login query (RFC 8252 and RFC 7636), gets a
 * code at APP_REDIRECT_URI instead, and trades it with its verifier at POST /v1/auth/exchange. Better Auth serves the
 * rest of /v1/auth/*, such as sign-out.
 */
export function authRoutes(app: Hono<{ Bindings: Env }>) {
  app.get(`${BASE_PATH}/login`, async (c) => {
    const env = setUp(c.env);
    const query = LoginQuery.safeParse(c.req.query());

    if (!query.success) return apiError('invalid_request');
    const appSignIn = 'redirect_uri' in query.data ? query.data : undefined;

    if (appSignIn && appSignIn.redirect_uri !== APP_REDIRECT_URI) return apiError('invalid_redirect');

    const callbackURL = appSignIn
      ? `${publicUrl(env)}${APP_CALLBACK_PATH}?${new URLSearchParams({ code_challenge: appSignIn.code_challenge })}`
      : `${publicUrl(env)}${BASE_PATH}/token`;

    const response = await auth(env).api.signInSocial({
      body: { provider: 'github', callbackURL },
      asResponse: true,
    });

    const headers = new Headers(response.headers);
    headers.set('Location', SignInRedirect.parse(await response.json()).url);
    headers.delete('Content-Type');

    return new Response(null, { status: 302, headers });
  });

  app.get(`${BASE_PATH}/token`, async (c) => {
    const session = await allowedSession(c.env, c.req.raw.headers);

    if (!session) return apiError('unauthorized');
    c.header('Cache-Control', 'no-store');

    return c.json(AuthToken.parse({ token: session.session.token }));
  });

  app.get(`${BASE_PATH}/callback/github`, async (c) => {
    const response = await githubCallback(c.env, c.req.raw);
    const location = response.headers.get('Location');
    const target = location === null ? undefined : new URL(location, c.req.url);

    return target?.pathname === APP_CALLBACK_PATH ? appRedirect(c.env, response, target) : response;
  });

  // No bearer token yet: the code and verifier are the proof. Every failure is the same error, so none tells an
  // attacker which part was wrong, and the code is spent on its first try either way.
  app.post(`${BASE_PATH}/exchange`, async (c) => {
    const parsed = ExchangeSignInCodeRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError('invalid_request');
    const { code, codeVerifier } = parsed.data;
    const row = await credentialsStub(c.env).takeSignInCode(code);
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');

    if (!row || row.expiresAt <= Date.now() || !sameSecret(challenge, row.codeChallenge)) {
      return apiError('invalid_sign_in_code');
    }

    c.header('Cache-Control', 'no-store');

    return c.json(AuthToken.parse({ token: row.token }));
  });

  app.on(['GET', 'POST'], `${BASE_PATH}/*`, (c) => auth(c.env).handler(c.req.raw));
}
