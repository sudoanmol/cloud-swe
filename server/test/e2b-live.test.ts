/**
 * Path: server/test/e2b-live.test.ts
 * Used by: pnpm test.
 * Purpose: Exercises the real E2B adapter and its lifecycle; runs only with pnpm test --e2b, and is billed.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, Session } from '@cloud-swe/protocol';
import { SessionCreation, WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { ToolCall } from '@earendil-works/pi-ai';
import { Sandbox } from 'e2b';
import { Effect } from 'effect';

import { toolResults } from '../../protocol/test/provider-request.ts';
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
import { forwardOutbound, runtime } from './runtime.ts';
import { checkSandboxAdapter, commandExited, newCommand } from './sandbox-live.ts';

// Billed: runs only with WORKSPACE_BACKEND=e2b, and every sandbox it creates is deleted.
const live = process.env.WORKSPACE_BACKEND === 'e2b';
const apiKey = process.env.E2B_API_KEY;
const env = { E2B_API_KEY: apiKey, WORKSPACE_BACKEND: 'e2b' } as const;
const run = <Value, Failure>(effect: Effect.Effect<Value, Failure>) => Effect.runPromise(effect);
const signal = () => AbortSignal.timeout(20_000);

const creationFor = (environment: string) =>
  SessionCreation.parse({
    request: {
      operationId: crypto.randomUUID(),
      environment,
      model: { provider: 'anthropic', id: 'configured-model' },
    },
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
    const sandboxId = await run(provisionWorkspace(env, creation));

    const workspace = WorkspaceRecord.parse({
      id: creation.workspaceId,
      sessionId: creation.sessionId,
      provider: 'e2b',
      sandboxId,
    });

    try {
      assert.equal(await run(waitForWorkspace(env, sandboxId)), 'running');
      assert.equal(await run(recoverOrProvisionWorkspace(env, creation)), sandboxId, 'a lost create is recovered');

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
      await run(waitForWorkspace(env, sandboxId, ['running']));
      assert.equal(await run(inspectWorkspace(env, sandboxId)), 'stopped');
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
  await assert.rejects(run(provisionWorkspace(env, creationFor('cloud-swe-no-such-template'))), { reason: 'refused' });
});

test(
  'through the Worker, a command survives a pause, and a message resumes the sandbox with its processes',
  { skip: !live, timeout: 300_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-e2b-'));
    const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
    const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };
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

    const mf = runtime(
      storage,
      {
        WORKSPACE_BACKEND: 'e2b',
        WORKSPACE_ENVIRONMENTS: 'cloud-swe',
        MODEL_ID: model.id,
        ANTHROPIC_API_KEY: 'fake-key',
        // Fast enough that a test sees both renewals: three intervals is the deadline of an active run.
        KEEPALIVE_INTERVAL_SECONDS: '2',
      },
      {
        outboundService: {
          type: 'fetcher',
          handler: async (request) => {
            if (new URL(request.url).hostname !== 'api.anthropic.com') return forwardOutbound(request);
            bodies.push(await request.text());

            return modelAnswer(model.id, calls.shift() ?? []);
          },
        },
      },
    );

    let sandboxId: string | undefined;

    try {
      const base = await mf.ready;
      const api = (path: string, init: RequestInit = {}) => fetch(new URL(path, base), { headers, ...init });

      const post = (path: string, body: Record<string, string | typeof model>) =>
        api(path, { method: 'POST', body: JSON.stringify(body) });

      const created = await post('/v1/sessions', {
        operationId: crypto.randomUUID(),
        environment: 'cloud-swe',
        model,
      });

      assert.equal(created.status, 201, await created.clone().text());
      const session = CreateSessionResponse.parse(await created.json()).session;
      assert.equal(session.workspace.provider, 'e2b');
      const path = '/v1/sessions/' + session.id;

      const message = async (text: string, mode = 'reject') => {
        const sent = await post(path + '/messages', { operationId: crypto.randomUUID(), text, mode });
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

      for (let attempt = 0; attempt < 40 && !sandboxId; attempt++) {
        const [found] = await Sandbox.list({
          apiKey,
          query: { metadata: { cloudSweWorkspace: session.workspace.id } },
        }).nextItems();

        sandboxId = found?.sandboxId;

        if (!sandboxId) await setTimeout(250);
      }

      assert.ok(sandboxId, 'the session has a sandbox');

      await message('Run the long command');

      // Wait until the long command is running, then pause under it, as E2B does at its plan's limit.
      for (let attempt = 0; attempt < 120; attempt++) {
        if (bodies.some((body) => toolResults(body).some((tool) => tool.callId === 'edit1'))) break;
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
      for (let attempt = 0; attempt < 30; attempt++) {
        const left = (await Sandbox.getInfo(sandboxId, { apiKey })).endAt.getTime() - Date.now();

        if (left > 300_000) break;
        await setTimeout(500);
      }

      const info = await Sandbox.getInfo(sandboxId, { apiKey });
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
