/**
 * Path: server/test/egress.test.ts
 * Used by: pnpm test.
 * Purpose: Transparent network secrets end to end on the egress double: unchanged curl and Node fetch reach a fake provider with the real key swapped in, while the sandbox holds only the placeholder. Covers hosts added mid-session, daemon respawn, visible truncation, HEAD, SSE and syncs that make no calls. Also `gh` reaching the fake GitHub as the App the same way.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, OperationReceipt, Session } from '@cloud-swe/protocol';
import { type Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';

import { DockerExecResult } from '../src/workspaces/docker.ts';
import { createSession, gitWorker } from './git-env.ts';
import { FakeGitHub } from './github-fake.ts';
import { modelAnswer } from './model-answer.ts';
import { toolResults } from './provider-request.ts';
import { type Call, callApi, type Json, model, waitFor } from './rig.ts';
import { cutResponse, forwardOutbound, runtime } from './runtime.ts';

// pnpm test always starts the egress double; a missing URL is a broken setup, not a reason to skip.
const SANDBOX = process.env.EGRESS_SANDBOX_URL ?? '';

if (!SANDBOX) throw new Error('EGRESS_SANDBOX_URL is required');

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

  if (url.pathname === '/break') return cutResponse(Array.from({ length: 3 }, () => 'chunk '.repeat(1000)));

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

test('network secrets are swapped in transparently on the egress double', { timeout: 180_000 }, async (t) => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-egress-'));
  const bash = (id: string, command: string) => [{ id, name: 'bash', arguments: { command } }];

  const calls: Call[][] = [
    bash('first', 'echo "KEY=$KEY"; curl -sS https://api.fakeprovider.test/echo -H "Authorization: Bearer $KEY"'),
    [],
    bash('second', 'curl -sS https://api.second.test/echo -H "Authorization: Bearer $SECOND"'),
    [],
    bash('third', 'true'),
    [],
  ];

  const bodies: string[] = [];
  const setupCalls: string[] = [];

  const mf = runtime(storage, {
    bindings: {
      MODEL_ID: model.id,
      ANTHROPIC_API_KEY: 'fake-key',
      PUBLIC_URL: `http://${hostname()}:${PORT}`,
      DOCKER_SANDBOX_URL: SANDBOX,
      DOCKER_SANDBOX_ROOT: '1',
    },
    dev: {
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
    listen: { host: '0.0.0.0', port: PORT },
  });

  try {
    const base = await mf.ready;

    const api = (path: string, method?: string, body?: Json) => callApi(base, path, method, body);

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
      const sent = await api(`/v1/sessions/${session.id}/conversations/1/messages`, 'POST', {
        operationId: crypto.randomUUID(),
        text,
      });

      assert.equal(sent.status, 202, await sent.clone().text());
      const { runId } = OperationReceipt.parse(await sent.json());

      await waitFor(
        async () => Session.parse(await (await api(`/v1/sessions/${session.id}`)).json()),
        ({ run }) => run.kind === 'completed' && run.runId === runId,
        60_000,
      );

      return toolResults(bodies.at(-1) ?? '').at(-1)?.output ?? '';
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
          /# BEGIN cloud-swe network secrets\n(?:.+github\.com\n){4}127\.0\.0\.1 api\.fakeprovider\.test\n::1 api\.fakeprovider\.test\n# END/,
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

      const resolved = await run(workspace, `getent hosts ${HOST}; getent hosts registry.npmjs.org || echo unresolved`);

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

      await waitFor(
        async () => ({
          now: (await rootFile(workspace, '/etc/cloud-swe/daemon.pid')).trim(),
          probe: await run(workspace, `curl -sS https://${HOST}/echo -H "Authorization: Bearer $KEY"`),
        }),
        ({ now, probe }) => now !== pid && /real-key/.test(probe.stdout),
      );
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
});

test('gh acts on GitHub as the App while the sandbox holds only a placeholder', { timeout: 180_000 }, async (t) => {
  const fake = await FakeGitHub.create();
  await fake.repo('octo', 'hello', { private: true });
  await fake.repo('acme', 'tool', { private: true });
  const calls: Call[][] = [];
  const bodies: string[] = [];

  const worker = await gitWorker(fake, 8808, calls, bodies, {
    DOCKER_SANDBOX_URL: SANDBOX,
    DOCKER_SANDBOX_ROOT: '1',
  });

  const { api } = worker;

  try {
    const session = await createSession(api, 'https://github.com/octo/hello');
    const workspace = session.workspace.id;

    /** Runs one shell command as the scripted agent and returns its output. */
    const agent = async (command: string) => {
      calls.push([{ id: crypto.randomUUID(), name: 'bash', arguments: { command } }]);

      const sent = await api(`/v1/sessions/${session.id}/conversations/1/messages`, 'POST', {
        operationId: crypto.randomUUID(),
        text: 'go',
      });

      assert.equal(sent.status, 202, await sent.clone().text());
      const { runId } = OperationReceipt.parse(await sent.json());

      await waitFor(
        async () => Session.parse(await (await api(`/v1/sessions/${session.id}`)).json()),
        ({ run }) => run.kind === 'completed' && run.runId === runId,
        60_000,
      );

      return toolResults(bodies.at(-1) ?? '').at(-1)?.output ?? '';
    };

    await t.test('an agent command reads a private repository with gh', async () => {
      const output = await agent(
        `timeout 60 sh -c 'until [ -f hello/README ]; do sleep 1; done'; echo "GH_TOKEN=$GH_TOKEN"; gh api repos/octo/hello/git/ref/heads/main --jq .object.sha`,
      );

      assert.match(output, /GH_TOKEN=cloudswe_ph_GH_TOKEN\n/);
      assert.ok(output.includes((await fake.sha('octo', 'hello', 'main')) ?? 'missing'), output);
      assert.equal(output.includes('ghs_'), false);
    });

    await t.test('it pushes a branch, opens a pull request and merges it, with nobody approving', async () => {
      const output = await agent(
        [
          'cd hello && git checkout -q -b work && echo change > change.txt && git add . && git commit -qm Work',
          'git push -q origin HEAD:cloud-swe/work',
          'gh api repos/octo/hello/pulls -f title=Work -f head=cloud-swe/work -f base=main --jq .number',
          `gh api -X PUT repos/octo/hello/pulls/1/merge -f sha=${'a'.repeat(40)} --jq .merged`,
        ].join(' && '),
      );

      assert.match(output, /^1\ntrue$/m, output);
      assert.ok(await fake.sha('octo', 'hello', 'cloud-swe/work'));
      assert.deepEqual(fake.pulls.get(1), {
        number: 1,
        title: 'Work',
        state: 'closed',
        merged: true,
        head: 'cloud-swe/work',
        sha: 'a'.repeat(40),
        base: 'main',
      });
    });

    await t.test("a call that names another installed account carries that account's token", async () => {
      const other = await run(workspace, 'gh api repos/acme/tool/git/ref/heads/main --jq .object.sha 2>&1');
      assert.equal(other.stdout.trim(), await fake.sha('acme', 'tool', 'main'));
      assert.deepEqual(fake.minted, ['octo', 'acme']);
    });

    await t.test("a call that names no account, as GraphQL does, acts for the base repository's owner", async () => {
      const viewer = await run(workspace, `gh api graphql -f query='{viewer{login}}' --jq .data.viewer.login 2>&1`);
      assert.equal(viewer.stdout.trim(), 'cloud-swe[bot]');
      assert.deepEqual(fake.graphql, ['octo']);
    });

    await t.test('a request with a token of its own goes to GitHub untouched', async () => {
      const own = await run(
        workspace,
        `curl -sS -o /dev/null -w '%{http_code}' https://api.github.com/repos/octo/hello/git/ref/heads/main -H 'Authorization: Bearer mine'`,
      );

      assert.equal(own.stdout, '401');
    });

    await t.test("the sandbox's files and the daemon's log hold no GitHub token", async () => {
      const hosts = await rootFile(workspace, '/etc/hosts');
      assert.match(hosts, /127\.0\.0\.1 api\.github\.com\n/);
      assert.match(hosts, /127\.0\.0\.1 uploads\.github\.com\n/);

      const held = [
        (await run(workspace, 'cat ~/.cloud-swe/env.json ~/.cloud-swe/git.config')).stdout,
        await rootFile(workspace, '/etc/cloud-swe/egress.json'),
        await rootFile(workspace, '/var/log/cloud-swe-egress.log'),
      ].join('\n');

      assert.match(held, /"GH_TOKEN":"cloudswe_ph_GH_TOKEN"/);
      assert.equal(held.includes('ghs_'), false);
    });
  } finally {
    await worker.close();
  }
});
