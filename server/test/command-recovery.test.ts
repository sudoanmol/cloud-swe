/**
 * Path: server/test/command-recovery.test.ts
 * Used by: pnpm test.
 * Purpose: Shell receipts survive lost responses and a restart; commands that are lost, killed, orphaned or unreachable always reach an end state and free the session.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CancelRunResponse, ListSessionsResponse } from '@cloud-swe/protocol';
import type { CommandIdentity } from '@cloud-swe/protocol';

import { type Intercept, lifecycleRig } from './lifecycle-rig.ts';
import { toolResults } from './provider-request.ts';
import { type Call, commandIdentity, commandProgress, runEnded, sandboxFile, waitFor } from './rig.ts';
import { DockerCommand } from './sandbox-tools.ts';

test(
  'shell receipts survive lost dispatch responses and a Worker restart; timeout and cancellation stop remote work',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig();
    let loseReceipt = false;
    const dispatches = () => rig.requests('POST', /\/commands$/).map(({ body }) => commandIdentity(body));

    rig.setIntercept(async (request, forward) => {
      if (!loseReceipt || !request.path.endsWith('/commands')) return undefined;
      loseReceipt = false;
      await forward();

      return new Response('receipt lost after execution began', { status: 503 });
    });

    const progress = (index: number) =>
      waitFor(async () => {
        const identity = dispatches()[index];

        return identity ? commandProgress(identity) : undefined;
      });

    try {
      const session = await rig.create();
      const path = `/v1/sessions/${session.id}/conversations/1`;
      const request = (suffix: string, body: Record<string, string>) => rig.api(path + suffix, body);
      const state = () => rig.session(session.id);
      const settled = () => rig.settled(session.id);
      const lastOutput = () => toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '';

      const send = async (command: string, timeout?: number) => {
        const args: Call['arguments'] = { command };

        if (timeout !== undefined) args.timeout = timeout;
        const call = { id: crypto.randomUUID(), name: 'bash', arguments: args };

        return rig.accepted(await rig.send(session.id, 'Run the next command', undefined, call));
      };

      loseReceipt = true;
      await send('printf once >> launches.txt; sleep 0.3; cat launches.txt');
      assert.equal((await settled()).run.kind, 'completed');
      assert.equal(dispatches().length, 1, 'a missing dispatch receipt never redispatches the shell');
      assert.match(lastOutput(), /once/);

      await send('printf restart-once >> restart.txt; printf before-restart; sleep 4; cat restart.txt');
      assert.equal((await progress(1)).kind, 'running');
      await rig.restart();
      assert.equal((await settled()).run.kind, 'completed');
      assert.equal(dispatches().length, 2, 'restart reattaches to the UUID job, not another command POST');
      assert.match(rig.bodies.at(-1) ?? '', /before-restartrestart-once/);
      assert.doesNotMatch(rig.bodies.at(-1) ?? '', /restart-oncerestart-once/);

      await send('printf timeout-start; sleep 10; printf must-not-finish', 0.25);
      assert.equal((await settled()).run.kind, 'completed', 'the model receives a tool error and can answer');
      const timed = await progress(2);
      assert.equal(timed.kind, 'exited');

      if (timed.kind === 'exited') assert.equal(timed.termination, 'timeout');
      assert.doesNotMatch(timed.output, /must-not-finish/);
      assert.match(lastOutput(), /timed out/);

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
      assert.equal(dispatches().length, 4);
      await send('printf successor');
      assert.equal((await settled()).run.kind, 'completed');
      assert.deepEqual(
        CancelRunResponse.parse(
          await (await request('/cancel', { operationId: cancelId, runId: active.runId })).json(),
        ),
        receipt,
      );
      assert.equal(dispatches().length, 5, 'stale cancellation never targets successor work');
    } finally {
      await rig.close();
    }
  },
);

/** A rig with one session whose model runs each sent command once. */
async function commandSession(intercept: Intercept = () => undefined) {
  const rig = await lifecycleRig();
  rig.setIntercept(intercept);
  const { id } = await rig.create();

  const post = (suffix: string, body: Record<string, string>) =>
    rig.api(`/v1/sessions/${id}/conversations/1${suffix}`, body);

  return {
    send: async (command?: string) =>
      rig.accepted(await rig.send(id, 'Run it', undefined, command ? rig.bash(command) : undefined)),
    // A killed supervisor is reported only after its heartbeat goes quiet.
    settled: () => waitFor(() => rig.session(id), runEnded, 40_000),
    post,
    run: async () => (await rig.session(id)).run,
    // The session's row in the list, which the Catalog holds.
    listedRun: async () => ListSessionsResponse.parse(await (await rig.api('/v1/sessions')).json()).sessions[0]?.run,
    lastResult: () => toolResults(rig.bodies.at(-1) ?? '').at(-1),
    close: rig.close,
  };
}

test(
  'a dispatch lost in transit ends as lost, frees the session, and cannot run if it arrives late',
  { timeout: 60_000 },
  async () => {
    let dropped: { path: string; body: string } | undefined;
    let attempts = 0;

    const session = await commandSession(({ path, body }) => {
      if (!path.endsWith('/commands')) return undefined;
      attempts++;

      if (attempts === 1) {
        dropped = { path, body };

        return new Response('connection lost before a receipt', { status: 503 });
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
      const identity = commandIdentity(dropped.body);

      await fetch(new URL(dropped.path, process.env.DOCKER_SANDBOX_URL), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.DOCKER_SANDBOX_TOKEN, 'Content-Type': 'application/json' },
        body: dropped.body,
      });

      const late = await waitFor(
        () => commandProgress(identity),
        (current) => current?.kind === 'exited',
      );

      assert.equal(late?.kind === 'exited' ? late.termination : undefined, 'cancelled');
      assert.equal(await sandboxFile(identity.workspaceId, 'late.txt'), undefined, 'the late command never ran');

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
    const session = await commandSession();

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

    const session = await commandSession(({ method, path }) => {
      if (path.endsWith('/commands')) dispatches++;

      return outage && method === 'GET' && path.endsWith('/file')
        ? new Response('temporarily unavailable', { status: 503 })
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

    const session = await commandSession(({ path, body }) => {
      if (path.endsWith('/commands')) dispatched = body;

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
async function orphanedCommand() {
  let stopWrites = false;
  let identity: ReturnType<typeof CommandIdentity.parse> | undefined;

  const session = await commandSession(({ path, body }) => {
    if (path.endsWith('/commands')) identity = commandIdentity(body);

    return stopWrites && path.endsWith('/file') && body.includes('.cancel')
      ? new Response('sandbox unreachable', { status: 503 })
      : undefined;
  });

  const active = await session.send('printf started; sleep 30; printf must-not-survive');

  const found = await waitFor(async () => identity);
  await setTimeout(500);
  stopWrites = true;
  const cancelled = await session.post('/cancel', { operationId: crypto.randomUUID(), runId: active.runId });
  assert.equal(cancelled.status, 503, 'the stop marker could not be written, so cancellation is unresolved');
  stopWrites = false;

  const progress = () => commandProgress(found);

  return { session, progress };
}

test(
  'an orphaned command is stopped by its own schedule, with no client reading the session',
  { timeout: 60_000 },
  async () => {
    const { session, progress } = await orphanedCommand();

    try {
      const current = await waitFor(progress, (value) => value?.kind === 'exited');

      assert.equal(current?.kind === 'exited' ? current.termination : current?.kind, 'cancelled');
      assert.doesNotMatch(current?.output ?? '', /must-not-survive/);

      // No Pi commit follows a command the reconciler closes, so it tells the list row itself.
      const run = await waitFor(session.run, (value) => value.kind !== 'uncertain');
      assert.deepEqual(await waitFor(session.listedRun, (value) => value?.kind === run.kind, 10_000), run);
    } finally {
      await session.close();
    }
  },
);

test('a message sent right after an orphan appears is accepted, not refused as busy', { timeout: 60_000 }, async () => {
  const { session } = await orphanedCommand();

  try {
    await session.send();
    assert.equal((await session.settled()).run.kind, 'completed');
  } finally {
    await session.close();
  }
});

test('a command whose sandbox is deleted ends as deleted, not as silent', { timeout: 60_000 }, async () => {
  let sandboxPath: string | undefined;

  const session = await commandSession(({ path }) => {
    if (path.endsWith('/commands')) sandboxPath = path.replace(/\/commands$/, '');

    return undefined;
  });

  try {
    await session.send('sleep 30');

    const path = await waitFor(
      async () => sandboxPath,
      (found) => found !== undefined,
    );

    await setTimeout(500);

    await fetch(new URL(path ?? '', process.env.DOCKER_SANDBOX_URL), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + process.env.DOCKER_SANDBOX_TOKEN },
    });

    assert.equal((await session.settled()).run.kind, 'completed');
    assert.match(session.lastResult()?.output ?? '', /sandbox was deleted/);
  } finally {
    await session.close();
  }
});
