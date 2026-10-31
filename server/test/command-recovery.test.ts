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
import { FileContent, ShellProgress } from '@cloud-swe/protocol/tools';
import type { ToolCall } from '@earendil-works/pi-ai';
import { Response as WorkerResponse } from 'miniflare';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { DockerCommand } from '../src/workspaces/docker.ts';
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
      assert.match(toolResults(modelBodies.at(-1) ?? '').at(-1)?.output ?? '', /once/);

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
      assert.match(toolResults(modelBodies.at(-1) ?? '').at(-1)?.output ?? '', /timed out/);

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

type Intercept = (url: string, body: string | undefined) => Promise<globalThis.Response | undefined>;

async function commandSession(prefix: string, intercept: Intercept = async () => undefined) {
  const storage = await mkdtemp(join(tmpdir(), prefix));
  const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
  let next: Pick<ToolCall, 'id' | 'name' | 'arguments'> | undefined;
  const bodies: string[] = [];

  const mf = runtime(storage, { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' }, {
    outboundService: {
      type: 'fetcher',
      handler: async (request) => {
        if (new URL(request.url).hostname === 'api.anthropic.com') {
          bodies.push(await request.text());
          const call = next;
          next = undefined;

          return modelAnswer(model.id, call ? [call] : []);
        }

        const body = request.method === 'GET' ? undefined : await request.text();
        const intercepted = await intercept(request.url, body);

        if (intercepted) return new WorkerResponse(await intercepted.arrayBuffer(), { status: intercepted.status });
        const response = await fetch(request.url, { method: request.method, headers: [...request.headers], body });

        return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
      },
    },
  } satisfies NonNullable<Parameters<typeof runtime>[2]>['outboundService'] extends infer O
    ? { outboundService: O }
    : never);

  const base = await mf.ready;

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
  const path = '/v1/sessions/' + CreateSessionResponse.parse(await created.json()).session.id;

  const post = (suffix: string, body: Record<string, string>) =>
    fetch(new URL(path + suffix, base), { method: 'POST', headers, body: JSON.stringify(body) });

  const send = async (command?: string) => {
    if (command) next = { id: crypto.randomUUID(), name: 'bash', arguments: { command } };
    const response = await post('/messages', { operationId: crypto.randomUUID(), text: 'Run it' });
    assert.equal(response.status, 202, await response.clone().text());

    return OperationReceipt.parse(await response.json());
  };

  const settled = async () => {
    for (let attempt = 0; attempt < 2000; attempt++) {
      const current = Session.parse(await (await fetch(new URL(path, base), { headers })).json());

      if (current.run.kind === 'completed' || current.run.kind === 'cancelled') return current;
      await setTimeout(20);
    }

    throw new Error('Run did not settle');
  };

  return {
    send,
    settled,
    post,
    lastResult: () => toolResults(bodies.at(-1) ?? '').at(-1),
    close: async () => {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    },
  };
}

function sandboxFetch(identity: { workspaceId: string; operationId: string }, route: string, path: string) {
  return fetch(
    new URL(
      `/workspaces/${identity.workspaceId}/${route}?path=${encodeURIComponent(path)}`,
      process.env.DOCKER_SANDBOX_URL,
    ),
    { headers: { Authorization: 'Bearer ' + process.env.DOCKER_SANDBOX_TOKEN } },
  );
}

test(
  'a dispatch lost in transit ends as lost, frees the session, and cannot run if it arrives late',
  { timeout: 60_000 },
  async () => {
    let dropped: { url: string; body: string } | undefined;
    let attempts = 0;

    const session = await commandSession('cloud-swe-command-lost-', async (url, body) => {
      if (!url.endsWith('/commands')) return undefined;
      attempts++;

      if (attempts === 1) {
        dropped = { url, body: body ?? '' };

        return new globalThis.Response('connection lost before a receipt', { status: 503 });
      }

      return undefined;
    });

    try {
      await session.send('printf ran > late.txt');
      assert.equal((await session.settled()).run.kind, 'completed');
      assert.equal(attempts, 1, 'a lost receipt never redispatches the shell');
      assert.equal(session.lastResult()?.isError, true);
      assert.match(session.lastResult()?.output ?? '', /stopped reporting/);

      assert.ok(dropped);
      const { command } = DockerCommand.parse(JSON.parse(dropped.body));

      const identity = {
        workspaceId: /"workspaceId":"([a-f0-9-]+)"/.exec(command)?.[1] ?? '',
        operationId: /"operationId":"([a-f0-9-]+)"/.exec(command)?.[1] ?? '',
      };

      await fetch(dropped.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.DOCKER_SANDBOX_TOKEN, 'Content-Type': 'application/json' },
        body: dropped.body,
      });
      let late: ReturnType<typeof ShellProgress.parse> | undefined;

      for (let attempt = 0; attempt < 200 && late?.kind !== 'exited'; attempt++) {
        const prefix = `/tmp/cloud-swe-${identity.workspaceId}-${identity.operationId}`;
        const response = await sandboxFetch(identity, 'file', prefix + '.json');

        if (response.ok) late = ShellProgress.parse(JSON.parse(FileContent.parse(await response.json()).content));
        await setTimeout(20);
      }

      assert.equal(late?.kind === 'exited' ? late.termination : undefined, 'cancelled');
      assert.equal((await sandboxFetch(identity, 'info', 'late.txt')).status, 404, 'the late command never ran');

      await session.send();
      assert.equal((await session.settled()).run.kind, 'completed');
    } finally {
      await session.close();
    }
  },
);

test(
  'a killed supervisor ends as lost, whether watched or cancelled, and new work proceeds',
  { timeout: 60_000 },
  async () => {
    const session = await commandSession('cloud-swe-command-killed-');

    try {
      await session.send('printf started; kill -9 $PPID; sleep 30');
      assert.equal((await session.settled()).run.kind, 'completed');
      assert.equal(session.lastResult()?.isError, true);
      assert.match(session.lastResult()?.output ?? '', /stopped reporting/);

      const active = await session.send('kill -9 $PPID; sleep 30');
      await setTimeout(500);
      const started = Date.now();
      const cancelled = await session.post('/cancel', { operationId: crypto.randomUUID(), runId: active.runId });
      assert.equal(cancelled.status, 202, await cancelled.clone().text());
      assert.ok(Date.now() - started < 10_000, 'cancellation does not wait out the watch limit');
      assert.equal((await session.settled()).run.kind, 'cancelled');

      await session.send('printf successor');
      assert.equal((await session.settled()).run.kind, 'completed');
      assert.match(session.lastResult()?.output ?? '', /successor/);
    } finally {
      await session.close();
    }
  },
);

test(
  'a sandbox API outage longer than a few seconds does not disturb a healthy command',
  { timeout: 60_000 },
  async () => {
    let outage = false;
    let dispatches = 0;

    const session = await commandSession('cloud-swe-command-outage-', async (url) => {
      if (url.endsWith('/commands')) dispatches++;

      return outage && url.includes('.json')
        ? new globalThis.Response('temporarily unavailable', { status: 503 })
        : undefined;
    });

    try {
      await session.send('printf before; sleep 8; printf after');
      await setTimeout(1000);
      outage = true;
      await setTimeout(6000);
      outage = false;
      assert.equal((await session.settled()).run.kind, 'completed');
      assert.equal(session.lastResult()?.isError, false);
      assert.match(session.lastResult()?.output ?? '', /beforeafter/);
      assert.equal(dispatches, 1);
    } finally {
      await session.close();
    }
  },
);

test(
  'a background process holding stdout does not block completion; commands default to the maximum timeout',
  { timeout: 30_000 },
  async () => {
    let dispatched = '';

    const session = await commandSession('cloud-swe-command-background-', async (url, body) => {
      if (url.endsWith('/commands')) dispatched = body ?? '';

      return undefined;
    });

    try {
      const started = Date.now();
      await session.send('sleep 25 & printf started');
      assert.equal((await session.settled()).run.kind, 'completed');
      assert.ok(Date.now() - started < 10_000, 'completion follows the shell, not its background child');
      assert.equal(session.lastResult()?.isError, false);
      assert.match(session.lastResult()?.output ?? '', /started/);
      assert.doesNotMatch(
        DockerCommand.parse(JSON.parse(dispatched)).command,
        /"timeoutSeconds"/,
        'no default timeout',
      );
    } finally {
      await session.close();
    }
  },
);

/** A cancelled run whose interruption failed: Pi has dropped the command, but it is still open and unresolved. */
async function orphanedCommand(prefix: string) {
  let stopWrites = false;
  let identity: ReturnType<typeof CommandIdentity.parse> | undefined;

  const session = await commandSession(prefix, async (url, body) => {
    if (url.endsWith('/commands')) {
      const { command } = DockerCommand.parse(JSON.parse(body ?? 'null'));

      identity = CommandIdentity.parse({
        workspaceId: /"workspaceId":"([a-f0-9-]+)"/.exec(command)?.[1],
        operationId: /"operationId":"([a-f0-9-]+)"/.exec(command)?.[1],
      });
    }

    return stopWrites && url.endsWith('/file') && body?.includes('.cancel')
      ? new globalThis.Response('sandbox unreachable', { status: 503 })
      : undefined;
  });

  const active = await session.send('printf started; sleep 30; printf must-not-survive');

  while (!identity) await setTimeout(20);
  await setTimeout(500);
  stopWrites = true;
  const cancelled = await session.post('/cancel', { operationId: crypto.randomUUID(), runId: active.runId });
  assert.equal(cancelled.status, 503, 'the stop marker could not be written, so cancellation is unresolved');
  stopWrites = false;

  const progress = async () => {
    const found = CommandIdentity.parse(identity);
    const response = await sandboxFetch(found, 'file', `/tmp/cloud-swe-${found.workspaceId}-${found.operationId}.json`);

    return ShellProgress.parse(JSON.parse(FileContent.parse(await response.json()).content));
  };

  return { session, progress };
}

test(
  'an orphaned command is stopped by its own schedule, with no client reading the session',
  { timeout: 60_000 },
  async () => {
    const { session, progress } = await orphanedCommand('cloud-swe-orphan-schedule-');

    try {
      let current = await progress();

      for (let attempt = 0; attempt < 300 && current.kind !== 'exited'; attempt++) {
        await setTimeout(100);
        current = await progress();
      }

      assert.equal(current.kind === 'exited' ? current.termination : current.kind, 'cancelled');
      assert.doesNotMatch(current.output, /must-not-survive/);
    } finally {
      await session.close();
    }
  },
);

test('a message sent right after an orphan appears is accepted, not refused as busy', { timeout: 60_000 }, async () => {
  const { session } = await orphanedCommand('cloud-swe-orphan-submit-');

  try {
    await session.send();
    assert.equal((await session.settled()).run.kind, 'completed');
  } finally {
    await session.close();
  }
});
