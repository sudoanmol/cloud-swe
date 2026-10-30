import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionCreation } from '@cloud-swe/protocol/storage';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';

import { inspectWorkspace, provisionWorkspace, waitForWorkspace } from '../src/workspaces/index.ts';

const sandboxId = 'bx_23456789';

const boatConfig = {
  WORKSPACE_BACKEND: 'boat',
  BOAT_API_KEY: 'boat_test_transport_only',
} satisfies Parameters<typeof inspectWorkspace>[0];

function creation(): SessionCreation {
  return SessionCreation.parse({
    request: {
      operationId: crypto.randomUUID(),
      engine: 'pi',
      target: 'cloud',
      environment: 'base',
      model: { provider: 'anthropic', id: 'configured-model' },
    },
    sessionId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
}

function sandboxInfo(state: string, health = 'ok', access = 'owner') {
  return Response.json({
    ok: true,
    type: 'sandbox.info',
    sandbox: { id: sandboxId, name: 'test', state, health, access, desktopAvailable: false, snapshotAvailable: false },
  });
}

test('Boat provisioning sends one idempotent create per operation and returns the sandbox ID', async (t) => {
  const input = creation();
  const bodies: unknown[] = [];
  let inProgress = 1;

  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://boat.dev/api/v1/sandboxes');
    assert.equal(init.method, 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer boat_test_transport_only');
    assert.equal(headers.get('Idempotency-Key'), input.request.operationId);
    bodies.push(JSON.parse(String(init.body)));

    if (inProgress-- > 0) {
      return Response.json({ ok: false, error: { code: 'idempotency_in_progress' } }, { status: 409 });
    }

    return Response.json({
      ok: true,
      type: 'sandbox.created',
      status: 'provisioning',
      ttlSeconds: null,
      sandbox: { id: sandboxId, name: `cloud-swe-${input.workspaceId}`, state: 'provisioning' },
    });
  });

  assert.equal(await advance(provisionWorkspace(boatConfig, input), 1000), sandboxId);
  assert.equal(bodies.length, 2, 'an in-progress create is retried with the same key');

  for (const body of bodies) {
    assert.deepEqual(body, { environment: 'base', name: `cloud-swe-${input.workspaceId}`, type: 'default' });
  }
});

test('Boat provisioning surfaces other errors and never creates without configuration', async (t) => {
  let calls = 0;

  t.mock.method(globalThis, 'fetch', async () => {
    calls++;

    return Response.json({ ok: false, error: { code: 'unknown_environment' } }, { status: 400 });
  });

  await assert.rejects(Effect.runPromise(provisionWorkspace(boatConfig, creation())), {
    _tag: 'WorkspaceError',
    reason: 'unavailable',
  });
  assert.equal(calls, 1, 'non-idempotency errors are not retried');
  await assert.rejects(Effect.runPromise(provisionWorkspace({ ...boatConfig, BOAT_API_KEY: '' }, creation())), {
    _tag: 'WorkspaceError',
    reason: 'configuration',
  });
  assert.equal(calls, 1, 'missing configuration must not issue a request');
});

test('a reused idempotency key is never retried even when its message mentions in-progress', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;

    return Response.json(
      { ok: false, error: { code: 'idempotency_key_reused', message: 'Not idempotency_in_progress' } },
      { status: 409 },
    );
  });

  await assert.rejects(advance(provisionWorkspace(boatConfig, creation()), 9000), {
    _tag: 'WorkspaceError',
    reason: 'unavailable',
  });
  assert.equal(calls, 1);
});

test('in-progress provisioning exhausts ten attempts and never exposes the upstream error', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;

    return Response.json(
      { ok: false, error: { code: 'idempotency_in_progress', message: 'private-provider-detail' } },
      { status: 409 },
    );
  });

  const error = await advance(Effect.flip(provisionWorkspace(boatConfig, creation())), 9000);
  assert.equal(error.reason, 'unavailable');
  assert.equal(calls, 10);
  assert.ok(!JSON.stringify(error).includes('private-provider-detail'));
});

test('an invalid create response is not retried', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;

    return Response.json({ ok: true, type: 'sandbox.created', sandbox: { id: 'not-a-sandbox' } });
  });

  await assert.rejects(Effect.runPromise(provisionWorkspace(boatConfig, creation())), {
    _tag: 'WorkspaceError',
    reason: 'invalid_response',
  });
  assert.equal(calls, 1);
});

test('official Boat SDK transport and documented states map to app workspace states', async (t) => {
  let nativeState = 'idle';
  let health = 'ok';
  let access = 'owner';

  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith('https://boat.dev/api/v1/sandboxes/bx_'));
    assert.ok(init.signal);

    return sandboxInfo(nativeState, health, access);
  });

  for (const [native, expected] of [
    ['ready', 'running'],
    ['idle', 'running'],
    ['running', 'running'],
    ['init', 'starting'],
    ['provisioning', 'starting'],
    ['provisioned', 'starting'],
    ['cloning', 'starting'],
    ['archiving', 'stopped'],
    ['archived', 'stopped'],
    ['error', 'error'],
    ['cancelled', 'error'],
  ]) {
    nativeState = native;
    assert.equal(await Effect.runPromise(inspectWorkspace(boatConfig, sandboxId)), expected);
  }

  nativeState = 'idle';
  health = 'degraded';
  assert.equal(await Effect.runPromise(inspectWorkspace(boatConfig, sandboxId)), 'unreachable');
  health = 'ok';
  access = 'view';
  await assert.rejects(Effect.runPromise(inspectWorkspace(boatConfig, sandboxId)), {
    _tag: 'WorkspaceError',
    reason: 'invalid_response',
  });
  access = 'owner';
  nativeState = 'unknown-new-state';
  await assert.rejects(Effect.runPromise(inspectWorkspace(boatConfig, sandboxId)), {
    _tag: 'WorkspaceError',
    reason: 'invalid_response',
  });
  await assert.rejects(Effect.runPromise(inspectWorkspace(boatConfig, 'bx_99999999')), {
    _tag: 'WorkspaceError',
    reason: 'invalid_response',
  });
});

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

    return sandboxInfo('provisioning');
  });

  assert.equal(await advance(waitForWorkspace(boatConfig, sandboxId), 58_000), 'starting');
  assert.equal(inspections, 30);
});

test('a new Boat sandbox is polled until it leaves starting', async (t) => {
  const states = ['provisioning', 'ready'];
  t.mock.method(globalThis, 'fetch', async () => sandboxInfo(states.shift() ?? 'ready'));

  assert.equal(await advance(waitForWorkspace(boatConfig, sandboxId), 2000), 'running');
  assert.deepEqual(states, []);
});

test('request deadlines abort pending SDK calls without dispatching another create', async (t) => {
  const signals: AbortSignal[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        assert.ok(init.signal);
        signals.push(init.signal);
        init.signal.addEventListener('abort', () => reject(new Error('Transport aborted')), { once: true });
      }),
  );

  const error = await advance(Effect.flip(provisionWorkspace(boatConfig, creation())), 30_000);
  assert.equal(error.reason, 'unavailable');
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});

test('cancelling an SDK call aborts its transport and does not launch retries', async (t) => {
  const signals: AbortSignal[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        assert.ok(init.signal);
        signals.push(init.signal);
        init.signal.addEventListener('abort', () => reject(new Error('Transport aborted')), { once: true });
      }),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(provisionWorkspace(boatConfig, creation()));
      yield* TestClock.adjust(0);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust(120_000);
      assert.equal(signals.length, 1);
      assert.equal(signals[0]?.aborted, true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test('the overall provisioning deadline bounds slow in-progress responses', async (t) => {
  const pending: Array<(response: Response) => void> = [];
  const signals: AbortSignal[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => {
        assert.ok(init.signal);
        signals.push(init.signal);
        pending.push(resolve);
      }),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(provisionWorkspace(boatConfig, creation())));

      for (let attempt = 0; attempt < 4; attempt++) {
        yield* TestClock.adjust(25_000);
        const respond = pending.shift();
        assert.ok(respond);
        respond(Response.json({ ok: false, error: { code: 'idempotency_in_progress' } }, { status: 409 }));
        yield* TestClock.adjust(1000);
      }

      yield* TestClock.adjust(16_000);
      assert.equal((yield* Fiber.join(fiber)).reason, 'unavailable');
      assert.equal(signals.length, 5);
      assert.equal(signals[4]?.aborted, true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test('cancellation stops scheduled readiness polling', async (t) => {
  let inspections = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    inspections++;

    return sandboxInfo('provisioning');
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(waitForWorkspace(boatConfig, sandboxId));
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
  await assert.rejects(Effect.runPromise(inspectWorkspace(config, input.workspaceId)), 'not provisioned yet');
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
