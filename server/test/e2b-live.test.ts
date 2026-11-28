/**
 * Path: server/test/e2b-live.test.ts
 * Used by: pnpm test.
 * Purpose: Exercises the real E2B adapter and its lifecycle, the network token's refusal while a real sandbox is paused, and a background command across pauses and a stop while paused; runs only with pnpm test --e2b, and is billed.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, OperationReceipt, Session } from '@cloud-swe/protocol';
import { BackgroundCommand, BackgroundOutput } from '@cloud-swe/protocol/background';
import { SessionCreation, WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { ToolCall } from '@earendil-works/pi-ai';
import { Sandbox } from 'e2b';
import { Effect } from 'effect';
import { Response as WorkerResponse } from 'miniflare';

import { EGRESS_PATHS, NONCE_HEADER, TOKEN_HEADER } from '../src/sandbox/egress-daemon.ts';
import { dispatchRemoteCommand, readRemoteFile, remoteFileInfo } from '../src/sandbox/remote.ts';
import { supervisorCommand } from '../src/sandbox/runner.ts';
import {
  deleteWorkspace,
  inspectWorkspace,
  provisionWorkspace,
  recoverOrProvisionWorkspace,
  renewWorkspace,
  resumeWorkspace,
  waitForWorkspace,
} from '../src/workspaces/index.ts';
import { modelAnswer } from './model-answer.ts';
import { toolResults } from './provider-request.ts';
import { callApi, headers, type Json, model, runEnded, waitFor } from './rig.ts';
import { configuredModel, forwardOutbound, runtime } from './runtime.ts';
import { checkSandboxAdapter, checkSandboxListing, commandExited, newCommand } from './sandbox-live.ts';

// Billed: runs only with WORKSPACE_BACKEND=e2b, and every sandbox it creates is deleted.
const live = process.env.WORKSPACE_BACKEND === 'e2b';
const apiKey = process.env.E2B_API_KEY;
const env = { E2B_API_KEY: apiKey, WORKSPACE_BACKEND: 'e2b' } as const;
const run = <Value, Failure>(effect: Effect.Effect<Value, Failure>) => Effect.runPromise(effect);
const signal = () => AbortSignal.timeout(20_000);

// This run's own Catalog ID, so nothing it lists can be another run's, local dev's or production's sandbox.
const catalogId = crypto.randomUUID();

const creationFor = (template: string) =>
  SessionCreation.parse({
    request: {
      operationId: crypto.randomUUID(),
    },
    template,
    model: configuredModel,
    sessionId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });

test(
  'the real E2B adapter and template pass the shared checks, and keep working through a pause',
  { skip: !live, timeout: 300_000 },
  async () => {
    // The real template, built by pnpm --filter server e2b:template.
    const creation = creationFor('cloud-swe');
    const sandboxId = await run(provisionWorkspace(env, creation, catalogId));

    const workspace = WorkspaceRecord.parse({
      id: creation.workspaceId,
      sessionId: creation.sessionId,
      provider: 'e2b',
      sandboxId,
    });

    try {
      assert.equal(await run(waitForWorkspace(env, sandboxId)), 'running');
      assert.equal(
        await run(recoverOrProvisionWorkspace(env, creation, catalogId)),
        sandboxId,
        'a lost create is recovered',
      );

      await checkSandboxListing(env, catalogId, sandboxId);
      await checkSandboxAdapter(env, workspace);

      const home = await remoteFileInfo(env, workspace, '.', signal());
      assert.equal(home.path, '/home/user', 'commands and files run as the unprivileged user');

      const running = newCommand(workspace);

      await dispatchRemoteCommand(
        env,
        workspace,
        supervisorCommand(running, {
          command: 'sleep 12; printf "$(id -un) $(node --version | cut -d. -f1) $(pnpm --version | cut -d. -f1)"',
          cwd: home.path,
        }),
        signal(),
      );

      // The full lifecycle mid-command: renew, pause by E2B, the renewal that can't see it, then resume.
      await run(renewWorkspace(env, sandboxId, 300));
      assert.equal(await Sandbox.pause(sandboxId, { apiKey }), true);
      assert.equal(await run(inspectWorkspace(env, sandboxId)), 'stopped');
      await assert.rejects(run(renewWorkspace(env, sandboxId, 300)));
      assert.equal(await run(inspectWorkspace(env, sandboxId)), 'stopped', 'a failed renewal is not a deletion');

      await run(resumeWorkspace(env, sandboxId, 300));
      assert.equal(await run(inspectWorkspace(env, sandboxId)), 'running');

      const done = await commandExited(env, workspace, running);
      assert.equal(done.kind === 'exited' && done.exitCode, 0, done.output);
      assert.match(done.output, /^user v24 \d+$/, 'the command survived the pause, on the template it was built for');

      // Reading a paused sandbox wakes it, which is how a polled command continues past E2B's hour.
      assert.equal(await Sandbox.pause(sandboxId, { apiKey }), true);
      assert.equal((await remoteFileInfo(env, workspace, '.', signal())).kind, 'directory');
      assert.equal(await run(inspectWorkspace(env, sandboxId)), 'running');

      // A finished run's short deadline really shortens the sandbox's life, and it pauses rather than dies.
      await run(renewWorkspace(env, sandboxId, 5));
      const info = await Sandbox.getInfo(sandboxId, { apiKey });
      assert.equal(info.lifecycle?.onTimeout, 'pause');
      assert.ok(info.endAt.getTime() - Date.now() < 10_000);

      let state = await run(inspectWorkspace(env, sandboxId));

      for (let tries = 0; state === 'running' && tries < 30; tries++) {
        await setTimeout(2000);
        state = await run(inspectWorkspace(env, sandboxId));
      }

      assert.equal(state, 'stopped', 'the sandbox paused at its short deadline');
    } finally {
      await run(deleteWorkspace(env, sandboxId));
    }

    await run(deleteWorkspace(env, sandboxId));
    assert.equal(await run(inspectWorkspace(env, sandboxId)), 'deleted');
    await assert.rejects(run(resumeWorkspace(env, sandboxId, 300)), { reason: 'expired' });
    await assert.rejects(readRemoteFile(env, workspace, '/tmp/anything', signal()), { code: 'not_found' });
  },
);

test('E2B refuses an unknown template with nothing created', { skip: !live, timeout: 60_000 }, async () => {
  await assert.rejects(run(provisionWorkspace(env, creationFor('cloud-swe-no-such-template'), catalogId)), {
    reason: 'refused',
  });
});

test(
  'through the Worker, a command survives a pause, and a message resumes the sandbox with its processes',
  { skip: !live, timeout: 300_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-e2b-'));
    const bodies: string[] = [];
    const call = (id: string, name: string, args: ToolCall['arguments']) => ({ id, name, arguments: args });

    const calls = [
      [call('write1', 'write', { path: 'note.txt', content: 'kept\n' })],
      [call('edit1', 'edit', { path: 'note.txt', edits: [{ oldText: 'kept', newText: 'edited' }] })],
      [
        call('long', 'bash', {
          // The background process proves the sandbox's memory came back, not just its disk.
          command: 'nohup sleep 900 >/dev/null 2>&1 & echo $! > sleeper.pid; sleep 15; printf finished',
        }),
      ],
    ];

    const mf = runtime(storage, {
      bindings: {
        WORKSPACE_BACKEND: 'e2b',
        WORKSPACE_TEMPLATES: 'cloud-swe',
        MODEL_ID: model.id,
        ANTHROPIC_API_KEY: 'fake-key',
        // Fast enough that a test sees both renewals: three intervals is the deadline of an active run.
        KEEPALIVE_INTERVAL_SECONDS: '2',
      },
      dev: {
        outboundService: {
          type: 'fetcher',
          handler: async (request) => {
            if (new URL(request.url).hostname !== 'api.anthropic.com') return forwardOutbound(request);
            bodies.push(await request.text());

            return modelAnswer(model.id, calls.shift() ?? []);
          },
        },
      },
    });

    let sandboxId: string | undefined;

    try {
      const base = await mf.ready;
      const api = (path: string, init: RequestInit = {}) => fetch(new URL(path, base), { headers, ...init });

      const post = (path: string, body: Record<string, string | typeof model>) =>
        api(path, { method: 'POST', body: JSON.stringify(body) });

      const created = await post('/v1/sessions', {
        operationId: crypto.randomUUID(),
        template: 'cloud-swe',
        model,
      });

      assert.equal(created.status, 201, await created.clone().text());
      const session = CreateSessionResponse.parse(await created.json()).session;
      const path = '/v1/sessions/' + session.id;

      const message = async (text: string, mode = 'reject') => {
        const sent = await post(path + '/conversations/1/messages', { operationId: crypto.randomUUID(), text, mode });
        assert.equal(sent.status, 202, await sent.clone().text());
      };

      const settled = async () => {
        for (let attempt = 0; attempt < 300; attempt++) {
          const current = Session.parse(await (await api(path)).json());

          if (['completed', 'failed'].includes(current.run.kind)) return current;
          await setTimeout(500);
        }

        throw new Error('The run did not settle');
      };

      const result = (callId: string) =>
        bodies.flatMap((body) => toolResults(body)).find((tool) => tool.callId === callId);

      let stamp: string | undefined;

      for (let attempt = 0; attempt < 40 && !sandboxId; attempt++) {
        const [found] = await Sandbox.list({
          apiKey,
          query: { metadata: { cloudSweWorkspace: session.workspace.id } },
        }).nextItems();

        sandboxId = found?.sandboxId;
        stamp = found?.metadata.cloudSweCatalog;

        if (!sandboxId) await setTimeout(250);
      }

      assert.ok(sandboxId, 'the session has a sandbox');
      assert.match(stamp ?? '', /^[0-9a-f-]{36}$/, "the Worker stamps its Catalog's ID on the sandbox");

      await message('Run the long command');

      // Wait until the long command is running, then pause under it, as E2B does at its plan's limit.
      for (let attempt = 0; !result('edit1'); attempt++) {
        if (attempt === 120) throw new Error('The edit before the long command never finished');
        await setTimeout(250);
      }

      await setTimeout(3000);
      assert.equal(await Sandbox.pause(sandboxId, { apiKey }), true);

      // The branch only E2B takes: a message resumes the sandbox, and its open command stays open.
      await message('A follow-up while paused', 'followUp');

      const first = await settled();
      assert.equal(first.run.kind, 'completed', JSON.stringify(first.run));
      const long = result('long');
      assert.ok(long);
      assert.equal(long.isError, false, long.output);
      assert.match(long.output, /finished/);
      assert.equal(first.workspace.state, 'running');

      // The finished run shortened the deadline to ten minutes, and the sandbox would pause rather than die.
      let info = await Sandbox.getInfo(sandboxId, { apiKey });

      for (let attempt = 0; info.endAt.getTime() - Date.now() <= 300_000; attempt++) {
        if (attempt === 30) throw new Error('The finished run never set the idle deadline');
        await setTimeout(500);
        info = await Sandbox.getInfo(sandboxId, { apiKey });
      }

      assert.ok(info.endAt.getTime() - Date.now() <= 600_000, 'finished runs have the idle deadline');
      assert.equal(info.lifecycle?.onTimeout, 'pause');

      // Idle and paused: the next message brings back files and the process left running.
      assert.equal(await Sandbox.pause(sandboxId, { apiKey }), true);
      calls.push([call('check', 'bash', { command: 'cat note.txt; kill -0 "$(cat sleeper.pid)" && echo alive' })]);
      await message('Check what survived');

      const second = await settled();
      assert.equal(second.run.kind, 'completed', JSON.stringify(second.run));
      const check = result('check');
      assert.ok(check);
      assert.equal(check.isError, false, check.output);
      assert.match(check.output, /edited/);
      assert.match(check.output, /alive/);
    } finally {
      if (sandboxId) await Sandbox.kill(sandboxId, { apiKey });
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);

test(
  'a paused E2B sandbox refuses its network token without waking, and a message restores it',
  { skip: !live, timeout: 300_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-e2b-net-'));
    const host = 'api.fakeprovider.test';
    const calls = [[{ id: 'sync', name: 'bash', arguments: { command: 'true' } }]];

    const mf = runtime(storage, {
      bindings: {
        WORKSPACE_BACKEND: 'e2b',
        WORKSPACE_TEMPLATES: 'cloud-swe',
        MODEL_ID: model.id,
        ANTHROPIC_API_KEY: 'k',
      },
      dev: {
        outboundService: {
          type: 'fetcher',
          handler: async (request) => {
            const { hostname } = new URL(request.url);

            if (hostname === host) return new WorkerResponse('ok');

            return hostname === 'api.anthropic.com'
              ? modelAnswer(model.id, calls.shift() ?? [])
              : forwardOutbound(request);
          },
        },
      },
    });

    let sandboxId: string | undefined;

    try {
      const base = await mf.ready;
      const api = (path: string, method?: string, body?: Json) => callApi(base, path, method, body);
      await api('/v1/environments/dev', 'PUT', {});
      await api('/v1/environments/dev/network-secrets/KEY', 'PUT', { value: 'sk-live-value', hosts: [host] });

      const created = await api('/v1/sessions', 'POST', {
        operationId: crypto.randomUUID(),
        template: 'cloud-swe',
        environment: 'dev',
        model,
      });

      assert.equal(created.status, 201, await created.clone().text());
      const session = CreateSessionResponse.parse(await created.json()).session;

      // A fresh command syncs the environment, which installs the daemon and its config with the token.
      const message = async (text: string) => {
        const sent = await api(
          `/v1/sessions/${session.id}/conversations/${session.activeConversationId}/messages`,
          'POST',
          {
            operationId: crypto.randomUUID(),
            text,
          },
        );

        assert.equal(sent.status, 202, await sent.clone().text());
        const { runId } = OperationReceipt.parse(await sent.json());

        const ended = await waitFor(
          async () => Session.parse(await (await api(`/v1/sessions/${session.id}`)).json()),
          (current) => runEnded(current) && 'runId' in current.run && current.run.runId === runId,
          120_000,
        );

        assert.equal(ended.run.kind, 'completed', JSON.stringify(ended.run));
      };

      await message('Sync the environment');

      const [found] = await Sandbox.list({
        apiKey,
        query: { metadata: { cloudSweWorkspace: session.workspace.id } },
      }).nextItems();

      sandboxId = found?.sandboxId;
      assert.ok(sandboxId, 'the session has a sandbox');

      // The agent can read the token with sudo; this is that copy, used from outside.
      const sandbox = await Sandbox.connect(sandboxId, { apiKey });
      const { token } = JSON.parse(await sandbox.files.read(EGRESS_PATHS.config, { user: 'root' }));

      const net = async () =>
        (
          await fetch(new URL(`/net/${session.id}/${host}/echo`, base), {
            headers: { [TOKEN_HEADER]: token, [NONCE_HEADER]: 'ab'.repeat(16) },
          })
        ).status;

      assert.equal(await net(), 200);

      assert.equal(await Sandbox.pause(sandboxId, { apiKey }), true);
      // A cached `running` is trusted for up to 15 s.
      await waitFor(net, (status) => status === 401);
      assert.equal((await Sandbox.getInfo(sandboxId, { apiKey })).state, 'paused', 'refusing never resumed it');

      await message('Resume');
      assert.equal(await net(), 200);
    } finally {
      if (sandboxId) await Sandbox.kill(sandboxId, { apiKey });
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);

test(
  'a background command never keeps a real sandbox awake, survives its pauses, and a stop while paused happens at the next wake-up',
  { skip: !live, timeout: 300_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-e2b-bg-'));
    // Short, so a run's final tick comes soon after it ends.
    const KEEPALIVE_SECONDS = 20;
    const ticker = 'echo $$ > /tmp/ticker.pid; i=0; while true; do echo tick-$i; i=$((i+1)); sleep 1; done';

    const calls: ToolCall[][] = [
      [{ type: 'toolCall', id: 'start', name: 'bash_background', arguments: { command: ticker } }],
    ];

    const bodies: string[] = [];

    const mf = runtime(storage, {
      bindings: {
        WORKSPACE_BACKEND: 'e2b',
        WORKSPACE_TEMPLATES: 'cloud-swe',
        MODEL_ID: model.id,
        ANTHROPIC_API_KEY: 'k',
      },
      dev: {
        outboundService: {
          type: 'fetcher',
          handler: async (request) => {
            if (new URL(request.url).hostname !== 'api.anthropic.com') return forwardOutbound(request);
            bodies.push(await request.text());

            return modelAnswer(model.id, calls.shift() ?? []);
          },
        },
      },
    });

    let sandboxId: string | undefined;

    try {
      const base = await mf.ready;
      const api = (path: string, method?: string, body?: Json) => callApi(base, path, method, body);
      const read = async () => Session.parse(await (await api(`/v1/sessions/${session.id}`)).json());

      const created = await api('/v1/sessions', 'POST', {
        operationId: crypto.randomUUID(),
        template: 'cloud-swe',
        model,
      });

      assert.equal(created.status, 201, await created.clone().text());
      const session = CreateSessionResponse.parse(await created.json()).session;

      const message = async (text: string) => {
        const path = `/v1/sessions/${session.id}/conversations/${session.activeConversationId}/messages`;
        const sent = await api(path, 'POST', { operationId: crypto.randomUUID(), text });
        assert.equal(sent.status, 202, await sent.clone().text());
        const { runId } = OperationReceipt.parse(await sent.json());

        const ended = await waitFor(read, (s) => runEnded(s) && 'runId' in s.run && s.run.runId === runId, 120_000);
        assert.equal(ended.run.kind, 'completed', JSON.stringify(ended.run));
      };

      const output = async (commandId: string) => {
        const response = await api(`/v1/sessions/${session.id}/background-commands/${commandId}/output`);
        assert.equal(response.status, 200, await response.clone().text());

        return BackgroundOutput.parse(await response.json());
      };

      const lastTick = (text: string) =>
        Math.max(-1, ...[...text.matchAll(/tick-(\d+)/g)].map((match) => Number(match[1])));

      for (let attempt = 0; !sandboxId; attempt++) {
        if (attempt === 60) throw new Error('The session never got a sandbox');

        const [found] = await Sandbox.list({
          apiKey,
          query: { metadata: { cloudSweWorkspace: session.workspace.id } },
        }).nextItems();

        sandboxId = found?.sandboxId;

        if (!sandboxId) await setTimeout(1000);
      }

      // A new sandbox starts with the idle deadline. Under 5 minutes, only the run's final tick can set it again.
      await Sandbox.setTimeout(sandboxId, 120_000, { apiKey });
      await message('Start the ticker');
      const [started] = (await read()).backgroundCommands;
      assert.ok(started);

      // The run's final tick sets the 10-minute idle deadline, then refreshes the command: its check is newer than the
      // tick before it, a whole interval earlier. The command never extends the deadline.
      // Checked once a second: each check is an E2B API call.
      const idle = async () => {
        for (let attempt = 0; attempt < 90; attempt++) {
          const { endAt } = await Sandbox.getInfo(sandboxId ?? '', { apiKey });

          if (endAt.getTime() - Date.now() > 300_000) return Date.now();
          await setTimeout(1000);
        }

        throw new Error('The finished run never set the idle deadline');
      };

      const finalTick = await idle();

      const refreshed = await waitFor(
        read,
        (s) => Date.parse(s.backgroundCommands[0]?.checkedAt ?? '') > finalTick - KEEPALIVE_SECONDS * 500,
        10_000,
      );

      assert.equal(refreshed.backgroundCommands[0]?.state, 'running');
      const info = await Sandbox.getInfo(sandboxId, { apiKey });
      assert.ok(info.endAt.getTime() - Date.now() <= 600_000, 'the command did not extend the idle deadline');

      // Asleep: the output route returns the saved tail and doesn't wake the sandbox.
      assert.equal(await Sandbox.pause(sandboxId, { apiKey }), true);
      const asleep = await output(started.id);
      assert.equal(asleep.live, false);
      assert.equal((await Sandbox.getInfo(sandboxId, { apiKey })).state, 'paused', 'reading never resumed it');

      // A message wakes it, and the ticks continue from where the pause froze them.
      calls.push([{ type: 'toolCall', id: 'read', name: 'bash_output', arguments: { id: started.id } }]);
      await message('Read the ticker');
      const result = toolResults(bodies.at(-1) ?? '').find(({ callId }) => callId === 'read');
      assert.ok(result && !result.isError, result?.output);
      assert.match(result.output, /: running\./);
      assert.ok(lastTick(result.output) > lastTick(asleep.text), result.output);
      // Asleep again: a stop is marked without waking it, and happens when the next message does.
      assert.equal(await Sandbox.pause(sandboxId, { apiKey }), true);
      const stopped = await api(`/v1/sessions/${session.id}/background-commands/${started.id}/stop`, 'POST', {});
      assert.equal(stopped.status, 200, await stopped.clone().text());
      const marked = BackgroundCommand.parse(await stopped.json());
      assert.equal(marked.state === 'running' && marked.stopping, true);
      assert.equal((await Sandbox.getInfo(sandboxId, { apiKey })).state, 'paused', 'the stop never resumed it');

      await message('Wake up');
      let ended = await output(started.id);

      // Checked once a second: each live read is a call into the sandbox.
      for (let attempt = 0; ended.command.state !== 'exited'; attempt++) {
        if (attempt === 30) throw new Error(`The stop never landed: ${JSON.stringify(ended.command)}`);
        await setTimeout(1000);
        ended = await output(started.id);
      }

      assert.deepEqual(ended.command.state === 'exited' && [ended.command.termination, ended.command.stoppedBy], [
        'stopped',
        'user',
      ]);

      const sandbox = await Sandbox.connect(sandboxId, { apiKey });

      const check = await sandbox.commands.run(
        'kill -0 "$(cat /tmp/ticker.pid)" 2>/dev/null && echo alive || echo gone',
      );

      assert.equal(check.stdout.trim(), 'gone');
    } finally {
      if (sandboxId) await Sandbox.kill(sandboxId, { apiKey });
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
