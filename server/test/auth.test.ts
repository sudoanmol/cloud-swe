import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ApiError } from '@cloud-swe/protocol';
import { AuthToken } from '@cloud-swe/protocol/credentials';
import { type Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';

import { runtime } from './runtime.ts';

const PORT = 8799;
const PUBLIC_URL = `http://127.0.0.1:${PORT}`;
const BETTER_AUTH_SECRET = 'auth-test-secret-auth-test-secret-auth-test';

function json(
  value: { access_token: string; token_type: string } | { id: number; login: string; name: string | null },
) {
  return new WorkerResponse(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

/** GitHub's OAuth endpoints; the access token says which account signed in. */
async function github(request: WorkerRequest) {
  const url = new URL(request.url);

  if (url.pathname === '/login/oauth/access_token') {
    const code = new URLSearchParams(await request.text()).get('code');

    return json({ access_token: 'user-' + code, token_type: 'bearer' });
  }

  if (url.pathname === '/user') {
    const account = request.headers.get('Authorization')?.endsWith('intruder')
      ? { id: 43, login: 'intruder', name: null }
      : { id: 42, login: 'octo', name: 'Octo Cat' };

    return json(account);
  }

  return new WorkerResponse('unexpected ' + url.href, { status: 500 });
}

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

/** Runs the browser's path through /login and GitHub's callback; returns where it ended and the session cookie. */
async function signIn(code: string) {
  const login = await fetch(`${PUBLIC_URL}/v1/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get('Location') ?? '');
  assert.equal(authorize.hostname, 'github.com');
  assert.equal(authorize.searchParams.get('client_id'), 'app-client-id');

  const callback = await fetch(
    `${PUBLIC_URL}/v1/auth/callback/github?code=${code}&state=${authorize.searchParams.get('state')}`,
    { redirect: 'manual', headers: { Cookie: cookies(login) } },
  );

  assert.equal(callback.status, 302);

  return { location: callback.headers.get('Location') ?? '', cookie: cookies(callback) };
}

test('only the allowed GitHub account can sign in and reach the API', { timeout: 60_000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-auth-'));
  const dev = { outboundService: { type: 'fetcher' as const, handler: github } };
  const listen = { host: '127.0.0.1', port: PORT };
  const app = { GITHUB_APP_CLIENT_ID: 'app-client-id', PUBLIC_URL, BETTER_AUTH_SECRET };
  let mf = runtime(storage, app, dev, undefined, listen);

  try {
    await mf.ready;

    const refused = await signIn('intruder');
    assert.match(refused.location, /error/);
    assert.equal(refused.cookie.includes('session_token'), false);
    const noSession = await fetch(`${PUBLIC_URL}/v1/auth/token`, { headers: { Cookie: refused.cookie } });
    assert.equal(noSession.status, 401);

    // There is no other way to create an account.
    const signUp = await fetch(`${PUBLIC_URL}/v1/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: PUBLIC_URL },
      body: JSON.stringify({ email: 'a@example.com', password: 'long-enough-password', name: 'a' }),
    });

    assert.equal(signUp.headers.get('set-auth-token'), null);
    assert.ok(signUp.status >= 400);

    const allowed = await signIn('octo');
    assert.equal(allowed.location, `${PUBLIC_URL}/v1/auth/token`);
    const shown = await fetch(allowed.location, { headers: { Cookie: allowed.cookie } });
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('Cache-Control'), 'no-store');
    const { token } = AuthToken.parse(await shown.json());

    const bearer = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: bearer })).status, 200);
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: { Cookie: allowed.cookie } })).status, 200);

    const unauthenticated = await fetch(`${PUBLIC_URL}/v1/sessions`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(ApiError.parse(await unauthenticated.json()).error.code, 'unauthorized');
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: { Authorization: 'Bearer nope' } })).status, 401);

    // A session outlives a restart, but not a change of the allowed account.
    await mf.dispose();
    mf = runtime(storage, app, dev, undefined, listen);
    await mf.ready;
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: bearer })).status, 200);

    await mf.dispose();
    mf = runtime(storage, { ...app, GITHUB_ALLOWED_USER_ID: '43' }, dev, undefined, listen);
    await mf.ready;
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: bearer })).status, 401);

    await mf.dispose();
    mf = runtime(storage, app, dev, undefined, listen);
    await mf.ready;

    const signOut = await fetch(`${PUBLIC_URL}/v1/auth/sign-out`, {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json', Origin: PUBLIC_URL },
      body: '{}',
    });

    assert.equal(signOut.status, 200);
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: bearer })).status, 401);

    // A missing app key is a setup error, not a repo the app happens not to be installed on.
    await mf.dispose();
    mf = runtime(storage, { ...app, GITHUB_APP_PRIVATE_KEY: '' }, dev, undefined, listen);
    await mf.ready;
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: bearer })).status, 503);
  } finally {
    await mf.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});
