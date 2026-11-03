/**
 * Path: server/test/network-proxy.test.ts
 * Used by: pnpm test.
 * Purpose: The /net route against a fake provider: the swap in the named header only, the token and host checks, stripped headers, refused redirects, redaction, the end-of-body trailer, no retries, WebSockets, and revocation when the sandbox is deleted or replaced.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, OperationReceipt, Session } from '@cloud-swe/protocol';
import type { ToolCall } from '@earendil-works/pi-ai';
import { type Request as WorkerRequest, Response as WorkerResponse, WebSocketPair } from 'miniflare';

import { networkAuthorization } from '../src/sandbox/egress.ts';
import { sandboxFile } from './git-env.ts';
import { modelAnswer } from './model-answer.ts';
import { forwardOutbound, runtime } from './runtime.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

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

    if (url.pathname === '/ws') {
      const [client, server] = Object.values(new WebSocketPair());
      server?.accept();
      server?.addEventListener('message', (event) =>
        server.send(`echo:${String(event.data)}:${request.headers.get('authorization')}`),
      );

      return new WorkerResponse(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/break') {
      const body = new NodeReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(new TextEncoder().encode('partial body '));
          await setTimeout(50);
          controller.error(new Error('upstream died'));
        },
      });

      // Miniflare ends a broken handler body cleanly, so the cut is made real: a declared length the body never reaches, on a
      // connection that closes after it, ends early for the Worker.
      return new WorkerResponse(body, { status: 200, headers: { 'Content-Length': '1000000', Connection: 'close' } });
    }

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

/** A raw HTTP call, so hop-by-hop headers and the body's last bytes are under the test's control. */
function raw(base: URL, path: string, headers: Record<string, string>, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
    (resolve, reject) => {
      const call = httpRequest(new URL(path, base), { method, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
        );
        response.on('error', reject);
      });

      call.on('error', reject);
      call.end();
    },
  );
}

test('network authorization fails closed when the catalog is unavailable', async () => {
  const now = new Date().toISOString();
  const workspaceId = crypto.randomUUID();
  const token = 'a'.repeat(64);

  const session = {
    id: crypto.randomUUID(),
    runtime: { conversationId: '1' },
    model: { provider: 'anthropic', id: 'm' },
    workspace: { id: workspaceId, provider: 'docker', state: 'running' },
    environment: 'dev',
    capabilities: { submitMessage: true, cancelRun: true, tools: [], approvals: true, delegation: false },
    run: { kind: 'idle' },
    createdAt: now,
    updatedAt: now,
  };

  const rows = new Map<string, unknown>([
    ['session', session],
    ['netAccess', { workspaceId, token }],
  ]);

  const catalog = (state: () => Promise<string>) => ({
    // SAFETY: networkAuthorization only calls idFromName and get(...).workspaceState on the catalog namespace.
    CATALOG: { idFromName: () => 'id', get: () => ({ workspaceState: state }) } as never,
  });

  // SAFETY: the rows above hold what the code reads under each key.
  const storage = { get: async <T>(key: string) => rows.get(key) as T | undefined } as never;

  const check = (state: () => Promise<string>, given = token) =>
    networkAuthorization({ env: catalog(state), storage }, given);

  assert.deepEqual(await check(async () => 'running'), { ok: true, environment: 'dev' });
  assert.deepEqual(await check(async () => 'stopped'), { ok: true, environment: 'dev' });
  assert.deepEqual(await check(async () => 'deleted'), { ok: false, reason: 'unauthorized' });
  assert.deepEqual(await check(async () => 'running', 'b'.repeat(64)), { ok: false, reason: 'unauthorized' });
  assert.deepEqual(await check(async () => 'running', 'a'.repeat(63)), { ok: false, reason: 'unauthorized' });

  assert.deepEqual(await check(() => Promise.reject(new Error('catalog down'))), { ok: false, reason: 'unavailable' });
});

test('the /net route swaps network secrets for approved hosts only', { timeout: 120_000 }, async (t) => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-net-'));
  const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
  const hits = new Map<string, number>();
  const provider = fakeProvider(hits);

  const calls: Pick<ToolCall, 'id' | 'name' | 'arguments'>[][] = [
    [{ id: 'sync', name: 'bash', arguments: { command: 'true' } }],
    [],
    [],
  ];

  let egressConfig: { token: string; sessionId: string; hosts: string[] } | undefined;
  const resumes: string[] = [];

  const mf = runtime(
    storage,
    { MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' },
    {
      outboundService: {
        type: 'fetcher',
        handler: async (request: WorkerRequest) => {
          const url = new URL(request.url);

          if (url.hostname === 'api.anthropic.com') return modelAnswer(model.id, calls.shift() ?? []);

          if (url.hostname === HOST) return provider(request);

          if (url.pathname.endsWith('/resume')) resumes.push(url.pathname);

          // The plain double can't run root setup; answer it here and keep the config the daemon would get.
          if (request.method === 'POST' && /\/(file|exec)$/.test(url.pathname)) {
            const body = JSON.parse(await request.clone().text());

            if (body.user === 'root') {
              if (String(body.path).endsWith('egress.json.next')) egressConfig = JSON.parse(body.content);

              return url.pathname.endsWith('/exec')
                ? new WorkerResponse(JSON.stringify({ exitCode: 0, stdout: 'applied\n' }))
                : new WorkerResponse(JSON.stringify({ written: true }));
            }
          }

          return forwardOutbound(request);
        },
      },
    },
  );

  const auth = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };

  try {
    const base = await mf.ready;

    const api = async (path: string, method = 'GET', body?: Json) => {
      const init: RequestInit = { method, headers: auth };

      if (body !== undefined) init.body = JSON.stringify(body);

      return fetch(new URL(path, base), init);
    };

    await api('/v1/environments/dev', 'PUT', {});
    await api('/v1/environments/dev/network-secrets/OPENAI_API_KEY', 'PUT', { value: SECRET, hosts: [HOST] });
    await api('/v1/environments/dev/network-secrets/BASIC_KEY', 'PUT', { value: BASIC_SECRET, hosts: [HOST] });
    await api('/v1/environments/dev/network-secrets/ELSEWHERE', 'PUT', { value: 'x', hosts: ['api.elsewhere.test'] });

    const created = await api('/v1/sessions', 'POST', {
      operationId: crypto.randomUUID(),
      template: 'base',
      environment: 'dev',
      model,
    });

    const session = CreateSessionResponse.parse(await created.json()).session;

    const settle = async (runId: string) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const current = Session.parse(await (await api(`/v1/sessions/${session.id}`)).json());

        if (current.run.kind === 'completed' && current.run.runId === runId) return current;
        await setTimeout(50);
      }

      throw new Error('run did not complete');
    };

    const sent = await api(`/v1/sessions/${session.id}/messages`, 'POST', {
      operationId: crypto.randomUUID(),
      text: 'go',
    });

    await settle(OperationReceipt.parse(await sent.json()).runId);

    assert.ok(egressConfig, 'the sync wrote the daemon config');
    assert.equal(egressConfig.sessionId, session.id);
    assert.deepEqual(egressConfig.hosts, ['api.elsewhere.test', HOST]);
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

    await t.test('a deleted, then replaced, sandbox revokes the token without waking anything', async () => {
      await fetch(new URL(`/workspaces/${session.workspace.id}`, process.env.DOCKER_SANDBOX_URL), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${process.env.DOCKER_SANDBOX_TOKEN}` },
      });

      // The catalog caches workspace state for 15 s.
      for (let attempt = 0; ; attempt++) {
        const current = Session.parse(await (await api(`/v1/sessions/${session.id}`)).json());

        if (current.workspace.state === 'deleted') break;
        assert.ok(attempt < 60, 'the deletion became visible');
        await setTimeout(500);
      }

      const before = resumes.length;
      assert.equal((await raw(base, net('/echo'), routing)).status, 401);
      assert.equal(resumes.length, before, 'authorization never resumes a sandbox');

      const next = await api(`/v1/sessions/${session.id}/messages`, 'POST', {
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
