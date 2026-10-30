import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionCreation } from '@cloud-swe/protocol/storage';

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

  assert.equal(await provisionWorkspace(boatConfig, input), sandboxId);
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

  await assert.rejects(provisionWorkspace(boatConfig, creation()));
  assert.equal(calls, 1, 'non-idempotency errors are not retried');
  await assert.rejects(provisionWorkspace({ ...boatConfig, BOAT_API_KEY: '' }, creation()));
  assert.equal(calls, 1, 'missing configuration must not issue a request');
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
    assert.equal(await inspectWorkspace(boatConfig, sandboxId), expected);
  }

  nativeState = 'idle';
  health = 'degraded';
  assert.equal(await inspectWorkspace(boatConfig, sandboxId), 'unreachable');
  health = 'ok';
  access = 'view';
  await assert.rejects(inspectWorkspace(boatConfig, sandboxId));
  access = 'owner';
  nativeState = 'unknown-new-state';
  await assert.rejects(inspectWorkspace(boatConfig, sandboxId));
  await assert.rejects(inspectWorkspace(boatConfig, 'bx_99999999'), 'a response for another sandbox is rejected');
});

test('a new Boat sandbox is polled until it leaves starting', async (t) => {
  const states = ['provisioning', 'ready'];
  t.mock.method(globalThis, 'fetch', async () => sandboxInfo(states.shift() ?? 'ready'));

  assert.equal(await waitForWorkspace(boatConfig, sandboxId), 'running');
  assert.deepEqual(states, []);
});

test('Docker double provisions one isolated directory per workspace and rejects wrong authentication', async () => {
  const config = {
    WORKSPACE_BACKEND: 'docker',
    DOCKER_SANDBOX_URL: process.env.DOCKER_SANDBOX_URL,
    DOCKER_SANDBOX_TOKEN: process.env.DOCKER_SANDBOX_TOKEN,
  } satisfies Parameters<typeof inspectWorkspace>[0];

  const input = creation();
  await assert.rejects(inspectWorkspace(config, input.workspaceId), 'not provisioned yet');
  assert.equal(await provisionWorkspace(config, input), input.workspaceId);
  assert.equal(await provisionWorkspace(config, input), input.workspaceId, 'provisioning is idempotent');
  assert.equal(await inspectWorkspace(config, input.workspaceId), 'running');
  await assert.rejects(inspectWorkspace(config, 'not-a-workspace-id'));
  await assert.rejects(inspectWorkspace({ ...config, DOCKER_SANDBOX_TOKEN: 'wrong-token' }, input.workspaceId));
});
