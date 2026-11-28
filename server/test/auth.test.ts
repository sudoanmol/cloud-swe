/**
 * Path: server/test/auth.test.ts
 * Used by: pnpm test.
 * Purpose: Only the allowed GitHub account can sign in and reach the API, from a browser or from the app with PKCE.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { mock } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { ApiError } from '@cloud-swe/protocol';
import { APP_REDIRECT_URI, AuthToken, SIGN_IN_CODE_TTL_SECONDS } from '@cloud-swe/protocol/credentials';
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

let refusals = 0;

/** GitHub's OAuth endpoints; the access token says which account signed in. */
async function github(request: WorkerRequest) {
  const url = new URL(request.url);

  if (url.pathname === '/login/oauth/access_token') {
    const code = new URLSearchParams(await request.text()).get('code');

    if (code === 'refused-once' && refusals++ < 1) return new WorkerResponse('restricted', { status: 429 });

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
async function signIn(code: string, query = '') {
  const login = await fetch(`${PUBLIC_URL}/v1/auth/login${query}`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get('Location') ?? '');
  assert.equal(authorize.hostname, 'github.com');
  assert.equal(authorize.searchParams.get('client_id'), 'app-client-id');

  const callback = await fetch(
    `${PUBLIC_URL}/v1/auth/callback/github?code=${code}&state=${authorize.searchParams.get('state')}`,
    { redirect: 'manual', headers: { Cookie: cookies(login) } },
  );

  assert.equal(callback.status, 302);

  return { location: callback.headers.get('Location') ?? '', cookie: cookies(callback), callback };
}

const dev = { outboundService: { type: 'fetcher' as const, handler: github } };
const listen = { host: '127.0.0.1', port: PORT };
const app = { GITHUB_APP_CLIENT_ID: 'app-client-id', PUBLIC_URL, BETTER_AUTH_SECRET };

test('only the allowed GitHub account can sign in and reach the API', { timeout: 60_000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-auth-'));
  let mf = runtime(storage, { bindings: app, dev, listen });

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

    const retried = await signIn('refused-once');
    assert.equal(retried.location, `${PUBLIC_URL}/v1/auth/token`, 'a refused code exchange is retried');
    assert.equal(refusals, 2);
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: bearer })).status, 200);
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: { Cookie: allowed.cookie } })).status, 200);

    const unauthenticated = await fetch(`${PUBLIC_URL}/v1/sessions`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(ApiError.parse(await unauthenticated.json()).error.code, 'unauthorized');
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: { Authorization: 'Bearer nope' } })).status, 401);

    // A session outlives a restart, but not a change of the allowed account.
    await mf.dispose();
    mf = runtime(storage, { bindings: app, dev, listen });
    await mf.ready;
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: bearer })).status, 200);

    await mf.dispose();
    mf = runtime(storage, { bindings: { ...app, GITHUB_ALLOWED_USER_ID: '43' }, dev, listen });
    await mf.ready;
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: bearer })).status, 401);

    await mf.dispose();
    mf = runtime(storage, { bindings: app, dev, listen });
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
    mf = runtime(storage, { bindings: { ...app, GITHUB_APP_PRIVATE_KEY: '' }, dev, listen });
    await mf.ready;
    assert.equal((await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: bearer })).status, 503);
    const exchange = await fetch(`${PUBLIC_URL}/v1/auth/exchange`, { method: 'POST', body: '{}' });
    assert.equal(ApiError.parse(await exchange.json()).error.code, 'api_not_configured');
  } finally {
    await mf.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});

/** A PKCE verifier and its S256 challenge, as the app makes them. */
function pkce() {
  const verifier = randomBytes(32).toString('base64url');

  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const appQuery = (challenge: string, redirect = APP_REDIRECT_URI) =>
  '?' + new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' });

const exchange = (code: string, codeVerifier: string) =>
  fetch(`${PUBLIC_URL}/v1/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier }),
  });

/** Signs the app in as `account`; returns the code the server sent to the app. */
async function appCode(account: string, challenge: string) {
  const { location, cookie, callback } = await signIn(account, appQuery(challenge));
  const sent = new URL(location);
  assert.equal(`${sent.protocol}${sent.pathname}`, APP_REDIRECT_URI);
  assert.equal(callback.headers.get('Cache-Control'), 'no-store');
  assert.equal(cookie.includes('session_token'), false, 'the sign-in sheet keeps no session');
  const code = sent.searchParams.get('code') ?? '';
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);

  return code;
}

/** The sign-in codes the Credentials DO still stores. */
async function storedCodes(storage: string) {
  const files = await readdir(storage, { recursive: true });
  const path = files.find((name) => name.endsWith('.sqlite') && name.includes('Credentials'));
  assert.ok(path, 'the Credentials DO has a database');
  const database = new DatabaseSync(join(storage, path), { readOnly: true });

  try {
    return database.prepare(`SELECT key FROM _cf_KV WHERE key LIKE 'sign-in-code:%'`).all().length;
  } finally {
    database.close();
  }
}

/** Everything this process and the Worker print while `run` runs. */
async function printed(run: () => Promise<void>) {
  const writes = [mock.method(process.stdout, 'write'), mock.method(process.stderr, 'write')];

  try {
    await run();
    // Workerd's output reaches this process asynchronously.
    await setTimeout(500);
  } finally {
    for (const write of writes) write.mock.restore();
  }

  return writes.flatMap((write) => write.mock.calls.map((call) => String(call.arguments[0]))).join('');
}

test('the app signs in with PKCE, one exchange per code', { timeout: 120_000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-app-auth-'));
  const mf = runtime(storage, { bindings: app, dev, listen });
  // Error bodies, checked at the end for anything secret.
  const said: string[] = [];

  async function refusal(response: Response) {
    assert.equal(response.status, 400);
    const { error } = ApiError.parse(await response.json());
    said.push(error.message);

    return error.code;
  }

  try {
    await mf.ready;
    const { verifier, challenge } = pkce();

    // Refused before anything goes to GitHub.
    const query = appQuery(challenge, 'evil:/sign-in');
    const elsewhere = await fetch(`${PUBLIC_URL}/v1/auth/login${query}`, { redirect: 'manual' });
    assert.equal(await refusal(elsewhere), 'invalid_redirect');
    assert.equal(elsewhere.headers.get('Location'), null);

    for (const malformed of [
      '?redirect_uri=' + encodeURIComponent(APP_REDIRECT_URI),
      appQuery('short'),
      appQuery(challenge).replace('S256', 'plain'),
      appQuery(challenge) + '&extra=1',
      '?unknown=1',
    ]) {
      const login = await fetch(`${PUBLIC_URL}/v1/auth/login${malformed}`, { redirect: 'manual' });
      assert.equal(await refusal(login), 'invalid_request', malformed);
    }

    const secrets = [verifier, challenge];

    const output = await printed(async () => {
      // A wrong verifier is refused and spends the code; an unknown code looks the same.
      const guessed = await appCode('octo', challenge);
      secrets.push(guessed);
      assert.equal(await refusal(await exchange(guessed, pkce().verifier)), 'invalid_sign_in_code');
      assert.equal(await refusal(await exchange(guessed, verifier)), 'invalid_sign_in_code');
      assert.equal(
        await refusal(await exchange(randomBytes(32).toString('base64url'), verifier)),
        'invalid_sign_in_code',
      );

      const code = await appCode('octo', challenge);
      secrets.push(code);
      const traded = await exchange(code, verifier);
      assert.equal(traded.status, 200);
      assert.equal(traded.headers.get('Cache-Control'), 'no-store');
      const { token } = AuthToken.parse(await traded.json());
      secrets.push(token);
      const sessions = await fetch(`${PUBLIC_URL}/v1/sessions`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(sessions.status, 200);
      assert.equal(await refusal(await exchange(code, verifier)), 'invalid_sign_in_code', 'a code works once');

      for (const body of ['{}', 'not json', JSON.stringify({ code, codeVerifier: 'short' })]) {
        const malformed = await fetch(`${PUBLIC_URL}/v1/auth/exchange`, { method: 'POST', body });
        assert.equal(await refusal(malformed), 'invalid_request');
      }

      const raced = await appCode('octo', challenge);
      secrets.push(raced);
      const both = await Promise.all([exchange(raced, verifier), exchange(raced, verifier)]);
      assert.deepEqual(both.map((response) => response.status).sort(), [200, 400], 'two exchanges, one token');
      await Promise.all(both.map((response) => response.text()));

      const intruder = await signIn('intruder', appQuery(challenge));
      assert.match(intruder.location, /error/);
      assert.equal(intruder.location.startsWith(APP_REDIRECT_URI), false);
      assert.equal(await storedCodes(storage), 0, 'only the allowed account gets a code');
    });

    assert.match(output, /Unable to get user info/, "the Worker's own output is captured");
    const shown = output + said.join('\n');
    assert.equal(secrets.filter((value) => shown.includes(value)).length, 0, 'nothing secret is printed or answered');

    // A code nobody exchanges is deleted when it expires, and is refused after.
    const late = await appCode('octo', challenge);
    assert.equal(await storedCodes(storage), 1);
    // The code expires on the Worker's real clock.
    await setTimeout(SIGN_IN_CODE_TTL_SECONDS * 1000 + 2000);
    assert.equal(await storedCodes(storage), 0);
    assert.equal(await refusal(await exchange(late, verifier)), 'invalid_sign_in_code');
  } finally {
    await mf.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});
