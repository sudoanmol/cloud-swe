import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import {
  CancelRunResponse,
  CommandIdentity,
  CreateSessionResponse,
  OperationReceipt,
  Session,
} from '@cloud-swe/protocol';
import { DockerCommand, FileContent, ShellProgress } from '@cloud-swe/protocol/tools';
import type { ToolCall } from '@earendil-works/pi-ai';
import { Response as WorkerResponse } from 'miniflare';

import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };

test(
  'shell receipts survive lost dispatch responses and a Worker restart; timeout and cancellation stop remote work',
  { timeout: 60_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-command-recovery-'));
    const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
    const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' };
    let next: Pick<ToolCall, 'id' | 'name' | 'arguments'> | undefined;
    let loseReceipt = false;
    const dispatches: Array<ReturnType<typeof CommandIdentity.parse>> = [];
    const modelBodies: string[] = [];

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname === 'api.anthropic.com') {
            modelBodies.push(await request.text());
            const call = next;
            next = undefined;

            return modelAnswer(model.id, call ? [call] : []);
          }

          assert.equal(new URL(request.url).hostname, 'sandbox');
          const body = request.method === 'GET' ? undefined : await request.text();
          const response = await fetch(request.url, { method: request.method, headers: [...request.headers], body });

          if (request.url.endsWith('/commands')) {
            const { command } = DockerCommand.parse(JSON.parse(body ?? 'null'));
            dispatches.push(
              CommandIdentity.parse({
                workspaceId: /"workspaceId":"([a-f0-9-]+)"/.exec(command)?.[1],
                operationId: /"operationId":"([a-f0-9-]+)"/.exec(command)?.[1],
                runnerGeneration: /"runnerGeneration":"([a-f0-9-]+)"/.exec(command)?.[1],
              }),
            );

            if (loseReceipt) {
              loseReceipt = false;

              return new WorkerResponse('receipt lost after execution began', { status: 503 });
            }
          }

          return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
        },
      },
    } satisfies NonNullable<Parameters<typeof runtime>[2]>;

    let mf = runtime(storage, bindings, dev);
    let base = await mf.ready;
    let path = '';

    const request = (suffix = '', body?: Record<string, string>) =>
      fetch(new URL(path + suffix, base), {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

    const state = async () => Session.parse(await (await request()).json());

    const send = async (command: string, timeout?: number) => {
      const args: ToolCall['arguments'] = { command };

      if (timeout !== undefined) args.timeout = timeout;
      next = { id: crypto.randomUUID(), name: 'bash', arguments: args };
      const response = await request('/messages', { operationId: crypto.randomUUID(), text: 'Run the next command' });
      assert.equal(response.status, 202, await response.clone().text());

      return OperationReceipt.parse(await response.json());
    };

    const settled = async () => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const current = await state();

        if (current.run.kind === 'completed' || current.run.kind === 'cancelled' || current.run.kind === 'failed')
          return current;
        await setTimeout(20);
      }

      throw new Error('Run did not settle');
    };

    const progress = async (index: number) => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const identity = dispatches[index];

        if (identity) {
          const prefix = '/tmp/cloud-swe-' + identity.workspaceId + '-' + identity.operationId;

          const response = await fetch(
            new URL(
              '/workspaces/' + identity.workspaceId + '/file?path=' + encodeURIComponent(prefix + '.json'),
              process.env.DOCKER_SANDBOX_URL,
            ),
            {
              headers: { Authorization: 'Bearer ' + process.env.DOCKER_SANDBOX_TOKEN },
            },
          );

          if (response.ok) {
            const text = FileContent.parse(await response.json()).content;

            return ShellProgress.parse(JSON.parse(text));
          }
        }

        await setTimeout(20);
      }

      throw new Error('Remote command did not start');
    };

    try {
      const created = await fetch(new URL('/v1/sessions', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          engine: 'pi',
          target: 'cloud',
          environment: 'base',
          model,
        }),
      });

      assert.equal(created.status, 201);
      const session = CreateSessionResponse.parse(await created.json()).session;
      path = '/v1/sessions/' + session.id;

      loseReceipt = true;
      await send('printf once >> launches.txt; sleep 0.3; cat launches.txt');
      assert.equal((await settled()).run.kind, 'completed');
      assert.equal(dispatches.length, 1, 'a missing dispatch receipt never redispatches the shell');
      assert.match(modelBodies.at(-1) ?? '', /once/);

      await send('printf restart-once >> restart.txt; printf before-restart; sleep 4; cat restart.txt');
      assert.equal((await progress(1)).kind, 'running');
      await mf.dispose();
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;
      assert.equal((await settled()).run.kind, 'completed');
      assert.equal(dispatches.length, 2, 'restart reattaches to the UUID job, not another command POST');
      assert.match(modelBodies.at(-1) ?? '', /before-restartrestart-once/);
      assert.doesNotMatch(modelBodies.at(-1) ?? '', /restart-oncerestart-once/);

      await send('printf timeout-start; sleep 10; printf must-not-finish', 0.25);
      assert.equal((await settled()).run.kind, 'completed', 'the model receives a tool error and can answer');
      const timed = await progress(2);
      assert.equal(timed.kind, 'exited');

      if (timed.kind === 'exited') assert.equal(timed.termination, 'timeout');
      assert.doesNotMatch(timed.output, /must-not-finish/);
      assert.match(modelBodies.at(-1) ?? '', /timed out/);

      const active = await send('printf cancel-start; sleep 10; printf must-not-survive');
      assert.equal((await progress(3)).kind, 'running');
      const cancelId = crypto.randomUUID();
      const cancellation = await request('/cancel', { operationId: cancelId, runId: active.runId });
      assert.equal(cancellation.status, 202, await cancellation.clone().text());
      const receipt = CancelRunResponse.parse(await cancellation.json());
      const stopped = await progress(3);
      assert.equal(stopped.kind, 'exited');

      if (stopped.kind === 'exited') assert.equal(stopped.termination, 'cancelled');
      assert.doesNotMatch(stopped.output, /must-not-survive/);
      assert.equal((await state()).run.kind, 'cancelled');
      assert.deepEqual(
        CancelRunResponse.parse(
          await (await request('/cancel', { operationId: cancelId, runId: active.runId })).json(),
        ),
        receipt,
      );
      assert.equal(dispatches.length, 4);
      await send('printf successor');
      assert.equal((await settled()).run.kind, 'completed');
      assert.deepEqual(
        CancelRunResponse.parse(
          await (await request('/cancel', { operationId: cancelId, runId: active.runId })).json(),
        ),
        receipt,
      );
      assert.equal(dispatches.length, 5, 'stale cancellation never targets successor work');
    } finally {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);

test(
  'unidentified dispatch stays uncertain across restart and blocks new work instead of retrying',
  { timeout: 30_000 },
  async () => {
    const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-command-uncertain-'));
    const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
    const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' };
    let requests = 0;
    let models = 0;

    const dev = {
      outboundService: {
        type: 'fetcher',
        handler: async (request) => {
          if (new URL(request.url).hostname === 'api.anthropic.com') {
            return modelAnswer(
              model.id,
              models++ === 0 ? [{ id: 'unknown', name: 'bash', arguments: { command: 'printf do-not-repeat' } }] : [],
            );
          }

          assert.equal(new URL(request.url).hostname, 'sandbox');

          if (request.url.endsWith('/commands')) {
            requests++;

            return new WorkerResponse('connection lost before a receipt', { status: 503 });
          }

          const response = await fetch(request.url, { method: request.method, headers: [...request.headers] });

          return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
        },
      },
    } satisfies NonNullable<Parameters<typeof runtime>[2]>;

    let mf = runtime(storage, bindings, dev);
    let base = await mf.ready;

    try {
      const created = await fetch(new URL('/v1/sessions', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          engine: 'pi',
          target: 'cloud',
          environment: 'base',
          model,
        }),
      });

      const session = CreateSessionResponse.parse(await created.json()).session;
      const path = '/v1/sessions/' + session.id;

      const send = () =>
        fetch(new URL(path + '/messages', base), {
          method: 'POST',
          headers,
          body: JSON.stringify({ operationId: crypto.randomUUID(), text: 'hello' }),
        });

      assert.equal((await send()).status, 202);
      let found = false;

      for (let attempt = 0; attempt < 400; attempt++) {
        const current = Session.parse(await (await fetch(new URL(path, base), { headers })).json());

        if (current.run.kind === 'uncertain') {
          found = true;
          break;
        }

        await setTimeout(20);
      }

      assert.ok(found);
      assert.equal(requests, 1);
      assert.equal((await send()).status, 409);
      await mf.dispose();
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;
      const restarted = Session.parse(await (await fetch(new URL(path, base), { headers })).json());
      assert.equal(restarted.run.kind, 'uncertain');
      assert.equal((await send()).status, 409);
      assert.equal(requests, 1, 'no command POST after a lost receipt or restart');
    } finally {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    }
  },
);
