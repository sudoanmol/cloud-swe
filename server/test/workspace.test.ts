/**
 * Path: server/test/workspace.test.ts
 * Used by: pnpm test.
 * Purpose: The workspace backend contract through the Docker double: provisioning, readiness polling, and lifecycle settings.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionCreation } from '@cloud-swe/protocol/storage';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';

import { inspectWorkspace, provisionWorkspace, waitForWorkspace } from '../src/workspaces/index.ts';
import { workspaceSettings } from '../src/workspaces/settings.ts';

const sandboxId = 'fa879d6e-bd71-48df-a621-f070c8df45da';

const dockerConfig = {
  WORKSPACE_BACKEND: 'docker',
  DOCKER_SANDBOX_URL: 'http://sandbox.invalid',
  DOCKER_SANDBOX_TOKEN: 'transport-only',
} satisfies Parameters<typeof inspectWorkspace>[0];

function creation(): SessionCreation {
  return SessionCreation.parse({
    request: {
      operationId: crypto.randomUUID(),
      template: 'base',
      model: { provider: 'anthropic', id: 'configured-model' },
    },
    sessionId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
}

const sandboxInfo = (state: string) =>
  Response.json({ provider: 'docker', id: sandboxId, state, root: `/workspace/${sandboxId}` });

function advance<A, E>(operation: Effect.Effect<A, E>, milliseconds: number): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(operation);
      yield* TestClock.adjust(milliseconds);

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
}

test('readiness polling stops after 30 inspections without wall-clock sleeps', async (t) => {
  let inspections = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    inspections++;

    return sandboxInfo('starting');
  });

  assert.equal(await advance(waitForWorkspace(dockerConfig, sandboxId), 58_000), 'starting');
  assert.equal(inspections, 30);
});

test('a new sandbox is polled until it leaves starting', async (t) => {
  const states = ['starting', 'running'];
  t.mock.method(globalThis, 'fetch', async () => sandboxInfo(states.shift() ?? 'running'));

  assert.equal(await advance(waitForWorkspace(dockerConfig, sandboxId), 2000), 'running');
  assert.deepEqual(states, []);
});

test('cancellation stops scheduled readiness polling', async (t) => {
  let inspections = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    inspections++;

    return sandboxInfo('starting');
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(waitForWorkspace(dockerConfig, sandboxId));
      yield* TestClock.adjust(1000);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust(60_000);
      assert.equal(inspections, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test('Docker double provisions one isolated directory per workspace and rejects wrong authentication', async () => {
  const config = {
    WORKSPACE_BACKEND: 'docker',
    DOCKER_SANDBOX_URL: process.env.DOCKER_SANDBOX_URL,
    DOCKER_SANDBOX_TOKEN: process.env.DOCKER_SANDBOX_TOKEN,
  } satisfies Parameters<typeof inspectWorkspace>[0];

  const input = creation();
  assert.equal(await Effect.runPromise(inspectWorkspace(config, input.workspaceId)), 'deleted', 'not provisioned yet');
  assert.equal(await Effect.runPromise(provisionWorkspace(config, input)), input.workspaceId);
  assert.equal(
    await Effect.runPromise(provisionWorkspace(config, input)),
    input.workspaceId,
    'provisioning is idempotent',
  );
  assert.equal(await Effect.runPromise(inspectWorkspace(config, input.workspaceId)), 'running');
  await assert.rejects(Effect.runPromise(inspectWorkspace(config, 'not-a-workspace-id')), {
    _tag: 'WorkspaceError',
    reason: 'invalid_response',
  });
  await assert.rejects(
    Effect.runPromise(inspectWorkspace({ ...config, DOCKER_SANDBOX_TOKEN: 'wrong-token' }, input.workspaceId)),
  );
});

test('lifecycle settings default to the documented values and reject nonsense', () => {
  assert.deepEqual(workspaceSettings({}), {
    maxSandboxes: 4,
    deleteAfterMs: 7 * 86_400_000,
    keepAliveMs: 120_000,
    ttlSeconds: 360,
  });

  assert.equal(workspaceSettings({ MAX_SANDBOXES: '2', KEEPALIVE_INTERVAL_SECONDS: '1' }).ttlSeconds, 3);
  assert.throws(() => workspaceSettings({ MAX_SANDBOXES: '0' }));
});
