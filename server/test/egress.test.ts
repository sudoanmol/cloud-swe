/**
 * Path: server/test/egress.test.ts
 * Used by: pnpm test.
 * Purpose: Transparent network secrets end to end on the egress double: unchanged curl and Node fetch reach a fake provider with the real key swapped in, while the sandbox holds only the placeholder. Covers hosts added mid-session, daemon respawn, visible truncation, HEAD, SSE and syncs that make no calls.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, OperationReceipt, Session } from '@cloud-swe/protocol';
import type { ToolCall } from '@earendil-works/pi-ai';
import { type Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { DockerExecResult } from '../src/workspaces/docker.ts';
import { modelAnswer } from './model-answer.ts';
import { forwardOutbound, runtime } from './runtime.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const SANDBOX = process.env.EGRESS_SANDBOX_URL;
const SECRET = 'sk-egress-real-value';
const SECOND_SECRET = 'sk-second-real-value';
const HOST = 'api.fakeprovider.test';
const SECOND_HOST = 'api.second.test';
const PORT = 8790;

/** The fake provider never echoes the key: it says whether the real one arrived. */
async function provider(request: WorkerRequest) {
  const url = new URL(request.url);
  const auth = request.headers.get('authorization');
  const verdict = auth === `Bearer ${SECRET}` || auth === `Bearer ${SECOND_SECRET}` ? 'real-key' : 'wrong-key';

  if (url.pathname === '/break') {
    let sent = 0;

    const body = new NodeReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent++ < 3) controller.enqueue(new TextEncoder().encode('chunk '.repeat(1000)));
        else controller.error(new Error('upstream died'));

        await setTimeout(50);
      },
    });

    // Miniflare ends a broken handler body cleanly, so the cut is made real: a declared length the body never reaches, on a
    // connection that closes after it, ends early for the Worker.
    return new WorkerResponse(body, { status: 200, headers: { 'Content-Length': '1000000', Connection: 'close' } });
  }

  if (url.pathname === '/sse') {
    let event = 0;

    const body = new NodeReadableStream<Uint8Array>({
      async pull(controller) {
        await setTimeout(200);

        if (event === 3) return controller.close();
        controller.enqueue(new TextEncoder().encode(`data: event-${event++}\n\n`));
      },
    });

    return new WorkerResponse(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  return new WorkerResponse(`${verdict} ${request.method} ${url.pathname}\n`, { status: 200 });
}

async function sandbox(workspaceId: string, route: string, body: Json) {
  const response = await fetch(new URL(`/workspaces/${workspaceId}/${route}`, SANDBOX), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DOCKER_SANDBOX_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`sandbox ${route} failed: ${response.status}`);

  return response.json();
}

/** Runs a script as the sandbox user, with the env file's values exported, the way a supervisor would. */
async function run(workspaceId: string, script: string, user?: 'root') {
  const prelude = user
    ? ''
    : 'eval "$(node -e \'for (const [k, v] of Object.entries(require(process.env.HOME + "/.cloud-swe/env.json"))) console.log("export " + k + "=" + JSON.stringify(v))\')"; ';

  const command = { command: prelude + script, timeoutMs: 30_000 };
  const result = await sandbox(workspaceId, 'exec', user ? { ...command, user } : command);

  return DockerExecResult.parse(result);
}

async function rootFile(workspaceId: string, path: string) {
  const { stdout } = await run(workspaceId, `cat ${path}`, 'root');

  return stdout;
}

test(
  'network secrets are swapped in transparently on the egress double',
  { skip: !SANDBOX, timeout: 180_000 },
  async (t) => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-egress-'));
    const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
    const bash = (id: string, command: string) => [{ id, name: 'bash', arguments: { command } }];

    const calls: Pick<ToolCall, 'id' | 'name' | 'arguments'>[][] = [
      bash('first', 'echo "KEY=$KEY"; curl -sS https://api.fakeprovider.test/echo -H "Authorization: Bearer $KEY"'),
      [],
      bash('second', 'curl -sS https://api.second.test/echo -H "Authorization: Bearer $SECOND"'),
      [],
      bash('third', 'true'),
      [],
    ];

    const bodies: string[] = [];
    const setupCalls: string[] = [];

    const mf = runtime(
      storage,
      {
        MODEL_ID: model.id,
        ANTHROPIC_API_KEY: 'fake-key',
        PUBLIC_URL: `http://${hostname()}:${PORT}`,
        DOCKER_SANDBOX_URL: SANDBOX ?? '',
      },
      {
        outboundService: {
          type: 'fetcher',
          handler: async (request: WorkerRequest) => {
            const url = new URL(request.url);

            if (url.hostname === 'api.anthropic.com') {
              bodies.push(await request.text());

              return modelAnswer(model.id, calls.shift() ?? []);
            }

            if (url.hostname === HOST || url.hostname === SECOND_HOST) return provider(request);

            if (request.method === 'POST' && /\/(file|exec)$/.test(url.pathname)) setupCalls.push(url.pathname);

            return forwardOutbound(request);
          },
        },
      },
      undefined,
      { host: '0.0.0.0', port: PORT },
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
      await api('/v1/environments/dev/network-secrets/KEY', 'PUT', { value: SECRET, hosts: [HOST] });

      const created = await api('/v1/sessions', 'POST', {
        operationId: crypto.randomUUID(),
        template: 'base',
        environment: 'dev',
        model,
      });

      assert.equal(created.status, 201, await created.clone().text());
      const session = CreateSessionResponse.parse(await created.json()).session;
      const workspace = session.workspace.id;

      const send = async (text: string) => {
        const sent = await api(`/v1/sessions/${session.id}/messages`, 'POST', {
          operationId: crypto.randomUUID(),
          text,
        });

        assert.equal(sent.status, 202, await sent.clone().text());
        const { runId } = OperationReceipt.parse(await sent.json());

        for (let attempt = 0; attempt < 1200; attempt++) {
          const current = Session.parse(await (await api(`/v1/sessions/${session.id}`)).json());

          if (current.run.kind === 'completed' && current.run.runId === runId) {
            return toolResults(bodies.at(-1) ?? '').at(-1)?.output ?? '';
          }

          await setTimeout(50);
        }

        throw new Error('run did not complete');
      };

      await t.test(
        'an agent command reaches the provider with the real key; the sandbox holds a placeholder',
        async () => {
          const output = await send('first');
          assert.match(output, /KEY=cloudswe_ph_KEY_[0-9a-f]{32}/);
          assert.match(output, /real-key GET \/echo/);
          assert.equal(output.includes(SECRET), false);

          const hosts = await rootFile(workspace, '/etc/hosts');
          assert.match(
            hosts,
            /# BEGIN cloud-swe network secrets\n127\.0\.0\.1 api\.fakeprovider\.test\n::1 api\.fakeprovider\.test\n# END/,
          );

          const envFile = (await run(workspace, 'cat ~/.cloud-swe/env.json')).stdout;
          assert.equal(envFile.includes(SECRET), false);
          assert.equal((await rootFile(workspace, '/etc/cloud-swe/egress.json')).includes(SECRET), false);
        },
      );

      await t.test('Node fetch works unchanged, and a host without a secret never reaches the daemon', async () => {
        const node = await run(
          workspace,
          `node -e "fetch('https://${HOST}/echo', { headers: { authorization: 'Bearer ' + process.env.KEY } }).then((r) => r.text()).then(console.log)"`,
        );

        assert.match(node.stdout, /real-key GET \/echo/);

        const resolved = await run(
          workspace,
          `getent hosts ${HOST}; getent hosts registry.npmjs.org || echo unresolved`,
        );

        assert.match(resolved.stdout, /^(127\.0\.0\.1|::1)\s+api\.fakeprovider\.test/m);
        assert.doesNotMatch(resolved.stdout, /(127\.0\.0\.1|::1)\s+registry\.npmjs\.org/);
      });

      await t.test('HEAD, SSE and a cut body', async () => {
        const head = await run(
          workspace,
          `curl -sS -I -o /dev/null -w "%{http_code}" https://${HOST}/echo -H "Authorization: Bearer $KEY"`,
        );

        assert.equal(head.stdout.trim(), '200');

        const sse = await run(workspace, `curl -sS -N https://${HOST}/sse -H "Authorization: Bearer $KEY"`);
        assert.match(sse.stdout, /event-0[\s\S]*event-1[\s\S]*event-2/);

        const cut = await run(
          workspace,
          `curl -sS -o /dev/null https://${HOST}/break -H "Authorization: Bearer $KEY"; echo "exit=$?"`,
        );

        assert.doesNotMatch(cut.stdout, /exit=0\b/, 'a cut body is an error, never a clean end');

        const nodeCut = await run(
          workspace,
          `node -e "fetch('https://${HOST}/break').then((r) => r.text()).then(() => console.log('clean'), () => console.log('error'))"`,
        );

        assert.equal(nodeCut.stdout.trim(), 'error');
      });

      await t.test('a secret added mid-session reaches the next command', async () => {
        await api('/v1/environments/dev/network-secrets/SECOND', 'PUT', { value: SECOND_SECRET, hosts: [SECOND_HOST] });
        assert.match(await send('second'), /real-key GET \/echo/);
      });

      await t.test('an unchanged environment makes no setup call', async () => {
        const before = setupCalls.length;
        await send('third');
        assert.deepEqual(setupCalls.slice(before), []);
      });

      await t.test('a killed daemon respawns', async () => {
        const pid = (await rootFile(workspace, '/etc/cloud-swe/daemon.pid')).trim();
        await run(workspace, `kill ${pid}`, 'root');

        for (let attempt = 0; ; attempt++) {
          const now = (await rootFile(workspace, '/etc/cloud-swe/daemon.pid')).trim();
          const probe = await run(workspace, `curl -sS https://${HOST}/echo -H "Authorization: Bearer $KEY"`);

          if (now !== pid && /real-key/.test(probe.stdout)) break;
          assert.ok(attempt < 40, 'the daemon came back');
          await setTimeout(250);
        }
      });

      await t.test('the daemon log holds no key or placeholder', async () => {
        const log = await rootFile(workspace, '/var/log/cloud-swe-egress.log');
        assert.equal(log.includes(SECRET), false);
        assert.equal(log.includes('cloudswe_ph_'), false);
        assert.match(log, /egress daemon listening/);
      });
    } finally {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
