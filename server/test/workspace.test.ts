/**
 * Path: server/test/workspace.test.ts
 * Used by: pnpm test.
 * Purpose: The workspace backends: a lost create receipt recovers without a second sandbox, Boat renew, resume, delete and state mapping, and lifecycle settings.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionCreation } from '@cloud-swe/protocol/storage';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';

import {
  deleteWorkspace,
  inspectWorkspace,
  provisionWorkspace,
  recoverOrProvisionWorkspace,
  renewWorkspace,
  resumeWorkspace,
  waitForWorkspace,
} from '../src/workspaces/index.ts';
import { workspaceSettings } from '../src/workspaces/settings.ts';

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

function sandboxList(input: SessionCreation, ids: string[], hasMore = false) {
  return Response.json({
    ok: true,
    type: 'sandbox.list',
    sandboxes: ids.map((id) => ({ id, name: `cloud-swe-${input.workspaceId}` })),
    pageInfo: { hasMore, nextCursor: hasMore ? 'next' : null, limit: 2 },
  });
}

test('a lost Boat create receipt is recovered without a second create, even after the retry window', async (t) => {
  const input = creation();
  let created = false;
  let creates = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (init.method === 'GET') {
      const query = new URL(url).searchParams;
      assert.equal(query.get('namePrefix'), `cloud-swe-${input.workspaceId}`);
      assert.equal(query.get('limit'), '2');

      return sandboxList(input, created ? [sandboxId] : []);
    }

    creates++;
    created = true;
    throw new Error('Lost create receipt');
  });

  await assert.rejects(Effect.runPromise(recoverOrProvisionWorkspace(boatConfig, input)), { reason: 'unavailable' });
  assert.equal(await Effect.runPromise(recoverOrProvisionWorkspace(boatConfig, input)), sandboxId);
  assert.equal(
    await Effect.runPromise(
      recoverOrProvisionWorkspace(boatConfig, {
        ...input,
        createdAt: '2020-01-01T00:00:00Z',
      }),
    ),
    sandboxId,
  );
  assert.equal(creates, 1);
});

test('fresh recovery uses the original create body and idempotency key only after a complete empty lookup', async (t) => {
  const input = creation();
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    methods.push(String(init.method));

    if (init.method === 'GET') return sandboxList(input, []);
    assert.equal(new Headers(init.headers).get('Idempotency-Key'), input.request.operationId);
    assert.deepEqual(JSON.parse(String(init.body)), {
      environment: input.request.environment,
      name: `cloud-swe-${input.workspaceId}`,
      type: 'default',
    });

    return Response.json({ ok: true, type: 'sandbox.created', sandbox: { id: sandboxId } });
  });

  assert.equal(await Effect.runPromise(recoverOrProvisionWorkspace(boatConfig, input)), sandboxId);
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('expired intents, ambiguous lookups and unavailable lookups never create another sandbox', async (t) => {
  const input = creation();
  let response = sandboxList(input, []);
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(init.method, 'GET', 'uncertainty must never cause a create');

    return response;
  });

  await assert.rejects(
    Effect.runPromise(
      recoverOrProvisionWorkspace(boatConfig, {
        ...input,
        createdAt: '2020-01-01T00:00:00Z',
      }),
    ),
    { reason: 'uncertain' },
  );

  for (const ids of [[sandboxId, 'bx_99999999'], []]) {
    response = sandboxList(input, ids, ids.length === 0);
    await assert.rejects(Effect.runPromise(recoverOrProvisionWorkspace(boatConfig, input)), { reason: 'uncertain' });
  }

  response = Response.json({ ok: true, type: 'sandbox.list', sandboxes: [] });
  await assert.rejects(Effect.runPromise(recoverOrProvisionWorkspace(boatConfig, input)), {
    reason: 'invalid_response',
  });
  response = Response.json({ ok: false, error: { code: 'private-detail' } }, { status: 503 });
  await assert.rejects(Effect.runPromise(recoverOrProvisionWorkspace(boatConfig, input)), { reason: 'unavailable' });
});

test('recovery accepts only exact names, not a prefix match', async (t) => {
  const input = creation();
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (init.method === 'GET')
      return Response.json({
        ok: true,
        type: 'sandbox.list',
        sandboxes: [{ id: 'bx_99999999', name: `cloud-swe-${input.workspaceId}-different` }],
        pageInfo: { hasMore: false },
      });

    return Response.json({ ok: true, type: 'sandbox.created', sandbox: { id: sandboxId } });
  });

  assert.equal(await Effect.runPromise(recoverOrProvisionWorkspace(boatConfig, input)), sandboxId);
});

test('a stalled recovery lookup times out and aborts without issuing a create', async (t) => {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => {
    assert.equal(init.method, 'GET');
    assert.ok(init.signal);
    signals.push(init.signal);

    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
  });

  assert.equal(
    (await advance(Effect.flip(recoverOrProvisionWorkspace(boatConfig, creation())), 5000)).reason,
    'unavailable',
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});

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
    reason: 'refused',
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

  for (const [native = '', expected] of [
    ['ready', 'running'],
    ['idle', 'running'],
    ['running', 'running'],
    ['init', 'starting'],
    ['provisioning', 'starting'],
    ['provisioned', 'starting'],
    ['cloning', 'starting'],
    ['archiving', 'stopped'],
    ['archived', 'stopped'],
    ['error', 'deleted'],
    ['cancelled', 'deleted'],
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

const env = { WORKSPACE_BACKEND: 'boat', BOAT_API_KEY: 'boat_test_transport_only' } as const;

const boatError = (status: number, code: string) =>
  Response.json(
    { ok: false, type: 'sandbox.error', status, code, message: code, error: { code, message: code, status } },
    { status },
  );

const info = (state: string, dataExpiredAt?: string | null) =>
  Response.json({
    ok: true,
    type: 'sandbox.info',
    sandbox: { id: sandboxId, name: 'test', state, health: 'ok', access: 'owner', dataExpiredAt },
  });

function transport(t: test.TestContext, reply: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Headers }> = [];

  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init.headers),
    });

    return reply(url, init);
  });

  return calls;
}

test('renew sets the deadline with ttlSeconds; resume sets it again', async (t) => {
  const calls = transport(t, () => info('ready'));

  await Effect.runPromise(renewWorkspace(env, sandboxId, 360));
  await Effect.runPromise(resumeWorkspace(env, sandboxId, 360));

  assert.deepEqual(
    calls.map(({ method, path, body }) => [method, path, body]),
    [
      ['PATCH', `/api/v1/sandboxes/${sandboxId}`, { ttlSeconds: 360 }],
      ['POST', `/api/v1/sandboxes/${sandboxId}/resume`, { ttlSeconds: 360 }],
    ],
  );
});

test('resume maps 409 snapshot_data_expired to an expired workspace, and other failures stay retryable', async (t) => {
  let reply = () => boatError(409, 'snapshot_data_expired');
  transport(t, reply);
  await assert.rejects(Effect.runPromise(resumeWorkspace(env, sandboxId, 360)), { reason: 'expired' });

  reply = () => boatError(404, 'not_found');
  t.mock.method(globalThis, 'fetch', async () => reply());
  await assert.rejects(Effect.runPromise(resumeWorkspace(env, sandboxId, 360)), { reason: 'expired' });

  reply = () => boatError(503, 'out_of_capacity');
  await assert.rejects(Effect.runPromise(resumeWorkspace(env, sandboxId, 360)), { reason: 'unavailable' });
});

test('delete confirms with the sandbox ID and treats an already-deleted sandbox as done', async (t) => {
  let status = 202;

  const calls = transport(t, () =>
    status === 404
      ? boatError(404, 'not_found')
      : Response.json(
          {
            ok: true,
            type: 'sandbox.deleting',
            operation: {
              id: 'bdop_1',
              kind: 'sandbox',
              targetId: sandboxId,
              reason: 'explicit',
              status: 'pending',
              attemptCount: 0,
              requestedAt: new Date().toISOString(),
              completedAt: null,
            },
          },
          { status },
        ),
  );

  await Effect.runPromise(deleteWorkspace(env, sandboxId));
  assert.equal(calls[0]?.method, 'DELETE');
  assert.equal(calls[0]?.headers.get('x-ascii-confirm-delete'), sandboxId);

  status = 404;
  await Effect.runPromise(deleteWorkspace(env, sandboxId));
});

test('a deleted sandbox and an expired stopped one both read as deleted; a plain stopped one reads stopped', async (t) => {
  let reply = () => boatError(404, 'not_found');
  t.mock.method(globalThis, 'fetch', async () => reply());
  assert.equal(await Effect.runPromise(inspectWorkspace(env, sandboxId)), 'deleted');

  reply = () => info('archived', '2026-10-01T00:00:00Z');
  assert.equal(await Effect.runPromise(inspectWorkspace(env, sandboxId)), 'deleted');

  reply = () => info('archived', null);
  assert.equal(await Effect.runPromise(inspectWorkspace(env, sandboxId)), 'stopped');
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
