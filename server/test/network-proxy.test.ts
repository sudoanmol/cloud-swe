/**
 * Path: server/test/network-proxy.test.ts
 * Used by: pnpm test.
 * Purpose: The /net route against a fake provider: the swap in the named header only, the token, sandbox state and host checks, stripped headers, refused redirects, redaction, the end-of-body trailer, no retries, WebSockets, refusal while the sandbox is paused, and revocation when it is deleted or replaced.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, OperationReceipt, Session } from '@cloud-swe/protocol';
import { type Request as WorkerRequest, Response as WorkerResponse, WebSocketPair } from 'miniflare';

import { GITHUB_API_HOSTS, networkAuthorization } from '../src/sandbox/egress.ts';
import { DockerWorkspaceInfo } from '../src/workspaces/docker.ts';
import { fakeSession, memoryStorage } from './fakes.ts';
import { modelAnswer } from './model-answer.ts';
import { type Call, callApi, type Json, model, raw, sandboxFile, waitFor } from './rig.ts';
import { cutResponse, forwardOutbound, rootSetup, runtime } from './runtime.ts';

const HOST = 'api.fakeprovider.test';
const SECRET = 'sk-real-network-secret-value';
const BASIC_SECRET = 'basic-real-secret';

/** The fake provider: echoes what it received, and misbehaves on purpose on some paths. */
function fakeProvider(hits: Map<string, number>) {
  return async (request: WorkerRequest) => {
    const url = new URL(request.url);
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

    if (url.pathname === '/redirect')
      return new WorkerResponse(null, { status: 302, headers: { Location: 'https://evil.example/' } });

    if (url.pathname === '/ws-redirect')
      return new WorkerResponse(null, { status: 302, headers: { Location: 'https://unapproved.example.test/ws' } });

    if (url.pathname === '/ws') {
      const [client, server] = Object.values(new WebSocketPair());
      server?.accept();
      server?.addEventListener('message', (event) =>
        server.send(`echo:${String(event.data)}:${request.headers.get('authorization')}`),
      );

      const protocol = request.headers.get('sec-websocket-protocol');

      return new WorkerResponse(null, {
        status: 101,
        webSocket: client,
        headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined,
      });
    }

    if (url.pathname === '/break') return cutResponse(['partial body ']);

    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });

    const reply = new WorkerResponse(JSON.stringify({ url: request.url, method: request.method, headers }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Echo-Auth': headers.authorization ?? '' },
    });

    reply.headers.append('Set-Cookie', `auth=${headers.authorization ?? ''}`);
    reply.headers.append('Set-Cookie', 'other=1');

    return reply;
  };
}

test('network authorization: an unexpired token, and a sandbox that is running when read afresh', async () => {
  const workspaceId = crypto.randomUUID();
  const [token, older] = ['a'.repeat(64), 'c'.repeat(64)];

  const rows = new Map<string, unknown>([
    ['session', fakeSession(workspaceId)],
    [
      'netAccess',
      {
        workspaceId,
        tokens: [
          { token: older, expiresAt: Date.now() - 1 },
          { token, expiresAt: Date.now() + 3_600_000 },
        ],
      },
    ],
  ]);

  // SAFETY: networkAuthorization only calls get, which memoryStorage implements for single keys.
  const storage = memoryStorage(rows) as never;
  let reads: string[] = [];

  /** `cached` answers a plain read, `live` a fresh one; an Error is an unreachable catalog. */
  const check = (cached: string | Error, live: string | Error = cached, given = token) => {
    reads = [];

    const workspaceState = async (_session: string, _workspace: string, fresh = false) => {
      reads.push(fresh ? 'fresh' : 'cached');
      const state = fresh ? live : cached;

      if (state instanceof Error) throw state;

      return state;
    };

    // SAFETY: networkAuthorization only calls idFromName and get(...).workspaceState on the catalog namespace.
    const env = { CATALOG: { idFromName: () => 'id', get: () => ({ workspaceState }) } as never };

    return networkAuthorization({ env, storage }, given);
  };

  const allowed = { ok: true, environment: 'dev' };
  const unauthorized = { ok: false, reason: 'unauthorized' };
  const unavailable = { ok: false, reason: 'unavailable' };

  assert.deepEqual(await check('running'), allowed);
  assert.deepEqual(reads, ['cached'], 'a cached running is trusted');
  assert.deepEqual(await check('stopped', 'running'), allowed, 'just after a resume the cache can still say stopped');
  assert.deepEqual(reads, ['cached', 'fresh']);
  assert.deepEqual(await check('stopped'), unauthorized, 'a paused sandbox refuses its token');
  assert.deepEqual(await check('running', 'stopped'), allowed, 'up to the 15 s cache after a pause');
  assert.deepEqual(await check('deleted'), unauthorized);
  assert.deepEqual(reads, ['cached'], 'deleted is final');
  assert.deepEqual(await check('starting'), unavailable);
  assert.deepEqual(await check('unreachable'), unavailable, 'an unreadable provider is neither allowed nor refused');
  assert.deepEqual(await check('stopped', new Error('provider down')), unavailable);
  assert.deepEqual(await check(new Error('catalog down')), unavailable);

  assert.deepEqual(await check('running', 'running', 'b'.repeat(64)), unauthorized);
  assert.deepEqual(await check('running', 'running', 'a'.repeat(63)), unauthorized);
  assert.deepEqual(await check('running', 'running', older), unauthorized, 'an expired token');
  assert.deepEqual(reads, [], 'a refused token never reaches the catalog');

  rows.set('session', fakeSession(crypto.randomUUID()));
  assert.deepEqual(await check('running'), unauthorized, 'a replaced sandbox revokes every token');
});

test('the /net route swaps network secrets for approved hosts only', { timeout: 120_000 }, async (t) => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-net-'));
  const hits = new Map<string, number>();
  const provider = fakeProvider(hits);

  const calls: Call[][] = [[{ id: 'sync', name: 'bash', arguments: { command: 'true' } }], [], []];

  let egressConfig: { token: string; sessionId: string; hosts: string[] } | undefined;
  const resumes: string[] = [];

  // Worker-to-Worker routing is needed here: the Node fetcher bridge cannot return a non-101 WebSocket reply.
  const redirectUpstream = `
    export default { async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname === '${HOST}' && url.pathname === '/ws-redirect') {
        return new Response(null, { status: 302, headers: { Location: 'https://unapproved.example.test/ws' } });
      }
      if (url.hostname === 'unapproved.example.test') {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        server.addEventListener('message', () => server.send(url.hostname + ':' + request.headers.get('x-api-key')));
        return new Response(null, { status: 101, webSocket: client });
      }
      return fetch(request);
    } };
  `;

  const mf = runtime(storage, {
    bindings: { MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key', DOCKER_SANDBOX_ROOT: '1' },
    dev: { outboundService: { type: 'worker', worker: 'review-upstream' } },
    workers: [
      {
        config: {
          name: 'review-upstream',
          compatibilityDate: '2026-10-29',
          manifest: {
            mainModule: 'upstream.js',
            modules: { 'upstream.js': { type: 'esm', contents: redirectUpstream } },
          },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request: WorkerRequest) => {
              const url = new URL(request.url);

              if (url.hostname === 'api.anthropic.com') return modelAnswer(model.id, calls.shift() ?? []);

              if (url.hostname === HOST) return provider(request);

              if (url.pathname.endsWith('/resume')) resumes.push(url.pathname);

              // Answer root setup here and keep the config the daemon would get.
              const setup = rootSetup(request.method, url.pathname, await request.clone().text());

              if (setup) {
                egressConfig = setup.egress ?? egressConfig;

                return new WorkerResponse(JSON.stringify(setup.reply));
              }

              return forwardOutbound(request);
            },
          },
        },
      },
    ],
  });

  try {
    const base = await mf.ready;

    const api = (path: string, method?: string, body?: Json) => callApi(base, path, method, body);

    await api('/v1/environments/dev', 'PUT', {});
    await api('/v1/environments/dev/network-secrets/OPENAI_API_KEY', 'PUT', { value: SECRET, hosts: [HOST] });
    await api('/v1/environments/dev/network-secrets/BASIC_KEY', 'PUT', { value: BASIC_SECRET, hosts: [HOST] });
    await api('/v1/environments/dev/network-secrets/CUSTOM_KEY', 'PUT', {
      value: SECRET,
      hosts: [HOST],
      header: 'X-Api-Key',
    });
    await api('/v1/environments/dev/network-secrets/ELSEWHERE', 'PUT', { value: 'x', hosts: ['api.elsewhere.test'] });

    const created = await api('/v1/sessions', 'POST', {
      operationId: crypto.randomUUID(),
      template: 'base',
      environment: 'dev',
      model,
    });

    const session = CreateSessionResponse.parse(await created.json()).session;

    const settle = (runId: string) =>
      waitFor(
        async () => Session.parse(await (await api(`/v1/sessions/${session.id}`)).json()),
        ({ run }) => run.kind === 'completed' && run.runId === runId,
      );

    const sent = await api(`/v1/sessions/${session.id}/conversations/1/messages`, 'POST', {
      operationId: crypto.randomUUID(),
      text: 'go',
    });

    await settle(OperationReceipt.parse(await sent.json()).runId);

    assert.ok(egressConfig, 'the sync wrote the daemon config');
    assert.equal(egressConfig.sessionId, session.id);
    // The test Worker has a GitHub App configured, so GitHub's API hosts are always routed too.
    assert.deepEqual(egressConfig.hosts, [...GITHUB_API_HOSTS, 'api.elsewhere.test', HOST]);
    // The root command that moves it into place was answered above, so the file is still the next one.
    const envFile = JSON.parse((await sandboxFile(session.workspace.id, '.cloud-swe/env.json.next')) ?? '{}');
    const placeholder: string = envFile.OPENAI_API_KEY;
    const basicPlaceholder: string = envFile.BASIC_KEY;
    assert.match(placeholder, /^cloudswe_ph_OPENAI_API_KEY_[0-9a-f]{32}$/);
    assert.equal(JSON.stringify(envFile).includes(SECRET), false, 'the sandbox holds no network value');
    assert.equal(envFile.NODE_EXTRA_CA_CERTS, '/usr/local/share/ca-certificates/cloud-swe-sandbox.crt');

    const { token } = egressConfig;
    const nonce = 'ab'.repeat(16);
    const net = (path: string) => `/net/${session.id}/${HOST}${path}`;
    const routing = { 'x-cloud-swe-network-token': token, 'x-cloud-swe-nonce': nonce };

    await t.test('the placeholder is swapped in its named header only', async () => {
      const reply = await raw(base, net(`/echo?key=${placeholder}`), {
        ...routing,
        Authorization: `Bearer ${placeholder}`,
        'X-Other': placeholder,
        'X-Forwarded-For': '203.0.113.9',
        'Proxy-Authorization': 'Basic Zm9vOmJhcg==',
        'X-Drop': 'listed in connection',
        Connection: 'keep-alive, X-Drop',
      });

      assert.equal(reply.status, 200);
      const tail = reply.body.subarray(-17);
      assert.equal(tail.subarray(0, 16).toString('hex'), nonce, 'the trailer carries the nonce');
      assert.equal(tail[16], 0, 'and says the body is complete');

      const echoed = JSON.parse(reply.body.subarray(0, -17).toString());
      assert.equal(echoed.headers.authorization, `Bearer ${SECRET}`);
      assert.equal(echoed.headers['x-other'], placeholder);
      assert.ok(echoed.url.endsWith(`/echo?key=${placeholder}`), 'the query is untouched');

      for (const name of [
        'x-cloud-swe-network-token',
        'x-cloud-swe-nonce',
        'x-forwarded-for',
        'proxy-authorization',
        'x-drop',
      ]) {
        assert.equal(echoed.headers[name], undefined, name);
      }

      assert.equal(reply.headers['x-echo-auth'], 'Bearer [redacted]');
      assert.deepEqual(reply.headers['set-cookie'], ['auth=Bearer [redacted]', 'other=1']);
      assert.equal(JSON.stringify(reply.headers).includes(SECRET), false);
    });

    await t.test('a Basic credential is decoded, swapped and re-encoded', async () => {
      const basic = `Basic ${Buffer.from(`user:${basicPlaceholder}`).toString('base64')}`;
      const reply = await raw(base, net('/echo'), { ...routing, Authorization: basic });
      const echoed = JSON.parse(reply.body.subarray(0, -17).toString());
      assert.equal(echoed.headers.authorization, `Basic ${Buffer.from(`user:${BASIC_SECRET}`).toString('base64')}`);
    });

    await t.test('refusals', async () => {
      const unlisted = await raw(base, `/net/${session.id}/api.unlisted.test/echo`, routing);
      assert.equal(unlisted.status, 403);
      assert.equal(
        (
          await raw(base, `/net/${session.id}/api.elsewhere.test/x`, {
            ...routing,
            'x-cloud-swe-network-token': 'f'.repeat(64),
          })
        ).status,
        401,
      );
      assert.equal((await raw(base, net('/echo'), { 'x-cloud-swe-network-token': token })).status, 400);
      assert.equal((await raw(base, net('/echo'), { 'x-cloud-swe-nonce': nonce })).status, 401);
      assert.equal((await raw(base, `/net/${session.id}/127.0.0.1/echo`, routing)).status, 404);
      assert.equal((await raw(base, `/net/not-a-session/${HOST}/echo`, routing)).status, 404);
      assert.equal((await raw(base, `/net/${crypto.randomUUID()}/${HOST}/echo`, routing)).status, 401);
    });

    await t.test('a redirect is refused, not followed', async () => {
      const reply = await raw(base, net('/redirect'), routing);
      assert.equal(reply.status, 502);
      assert.equal(reply.headers.location, undefined);
      assert.match(reply.body.toString(), /upstream redirected/);
    });

    await t.test('a broken upstream body is marked in the trailer and never retried', async () => {
      const reply = await raw(base, net('/break'), routing);
      assert.equal(reply.status, 200);
      assert.equal(reply.body.subarray(-17, -1).toString('hex'), nonce);
      assert.equal(reply.body.at(-1), 1);
      assert.equal(hits.get('/break'), 1);
    });

    await t.test('HEAD has no body and no trailer', async () => {
      const reply = await raw(base, net('/echo'), routing, 'HEAD');
      assert.equal(reply.status, 200);
      assert.equal(reply.body.length, 0);
    });

    await t.test('WebSockets pass through with the swap', async () => {
      const url = new URL(net('/ws'), base);
      url.protocol = 'ws:';
      // SAFETY: Node's WebSocket (undici) accepts headers in its init object.
      const socket = new WebSocket(url, { headers: { ...routing, Authorization: `Bearer ${placeholder}` } } as never);

      const message = new Promise<string>((resolve, reject) => {
        socket.addEventListener('message', (event) => resolve(String(event.data)));
        socket.addEventListener('error', () => reject(new Error('websocket failed')));
      });

      await new Promise((resolve) => socket.addEventListener('open', resolve));
      socket.send('hi');
      assert.equal(await message, `echo:hi:Bearer ${SECRET}`);
      socket.close();
    });

    await t.test('a WebSocket redirect is refused, never followed with the key', async () => {
      const url = new URL(net('/ws-redirect'), base);
      url.protocol = 'ws:';

      // SAFETY: Node WebSocket accepts this extended initialization object.
      const socket = new WebSocket(url, {
        headers: { ...routing, 'X-Api-Key': envFile.CUSTOM_KEY },
      } as never);

      const result = await Promise.race([
        new Promise<string>((resolve) => {
          socket.addEventListener('open', () => socket.send('show received key'));
          socket.addEventListener('message', (event) => resolve(String(event.data)));
          socket.addEventListener('error', () => resolve('error'));
        }),
        setTimeout(2000, 'timeout'),
      ]);

      socket.close();

      assert.equal(result, 'error');
    });

    await t.test('the subprotocol the upstream chose reaches the client', async () => {
      const url = new URL(net('/ws'), base);
      url.protocol = 'ws:';

      // SAFETY: Node WebSocket accepts headers and protocols in its extended initialization object.
      const socket = new WebSocket(url, {
        protocols: ['review-protocol'],
        headers: routing,
      } as never);

      const result = await Promise.race([
        new Promise<string>((resolve) => {
          socket.addEventListener('open', () => resolve('open'));
          socket.addEventListener('error', () => resolve('error'));
        }),
        setTimeout(2000, 'timeout'),
      ]);

      const { protocol } = socket;
      socket.close();

      assert.equal(result, 'open');
      assert.equal(protocol, 'review-protocol');
    });

    await t.test('a paused sandbox refuses its token without waking; a resume restores it at once', async () => {
      const box = (action: string) =>
        fetch(new URL(`/workspaces/${session.workspace.id}${action}`, process.env.DOCKER_SANDBOX_URL), {
          method: action ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${process.env.DOCKER_SANDBOX_TOKEN}`, 'Content-Type': 'application/json' },
          body: action ? '{}' : undefined,
        });

      await box('/stop');
      const before = resumes.length;
      // A cached `running` is trusted for up to 15 s after the inspection that read it.
      await waitFor(
        async () => (await raw(base, net('/echo'), routing)).status,
        (status) => status === 401,
      );
      assert.equal(resumes.length, before, 'authorization never resumes a sandbox');
      // The inspection above cached `stopped`. Resumed behind the catalog's back, the cache is stale for 15 s.
      await box('/resume');
      await waitFor(
        async () => DockerWorkspaceInfo.parse(await (await box('')).json()).state,
        (state) => state === 'running',
      );
      assert.equal((await raw(base, net('/echo'), routing)).status, 200);
    });

    await t.test('a deleted, then replaced, sandbox revokes the token without waking anything', async () => {
      await fetch(new URL(`/workspaces/${session.workspace.id}`, process.env.DOCKER_SANDBOX_URL), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${process.env.DOCKER_SANDBOX_TOKEN}` },
      });

      // The catalog caches workspace state for 15 s.
      await waitFor(
        async () => Session.parse(await (await api(`/v1/sessions/${session.id}`)).json()),
        ({ workspace }) => workspace.state === 'deleted',
      );

      const before = resumes.length;
      assert.equal((await raw(base, net('/echo'), routing)).status, 401);
      assert.equal(resumes.length, before, 'authorization never resumes a sandbox');

      const next = await api(`/v1/sessions/${session.id}/conversations/1/messages`, 'POST', {
        operationId: crypto.randomUUID(),
        text: 'again',
      });

      assert.equal(next.status, 202, await next.clone().text());
      const replaced = await settle(OperationReceipt.parse(await next.json()).runId);
      assert.notEqual(replaced.workspace.id, session.workspace.id);
      assert.equal((await raw(base, net('/echo'), routing)).status, 401);
    });
  } finally {
    await mf.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});
