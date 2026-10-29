import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectWorkspace } from '../src/workspace.ts';

const boatConfig = {
  WORKSPACE_BACKEND: 'boat',
  BOAT_API_KEY: 'boat_test_transport_only',
  BOAT_SANDBOX_ID: 'bx_23456789',
} satisfies Parameters<typeof inspectWorkspace>[0];

test('official Boat SDK transport and documented states map to app workspace states', async (t) => {
  let nativeState = 'idle';
  let health = 'ok';
  let access = 'owner';
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(url, 'https://boat.dev/api/v1/sandboxes/bx_23456789');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer boat_test_transport_only');
    assert.ok(init.signal);

    return Response.json({
      ok: true,
      type: 'sandbox.info',
      sandbox: {
        id: boatConfig.BOAT_SANDBOX_ID,
        name: 'test',
        state: nativeState,
        health,
        access,
        desktopAvailable: false,
        snapshotAvailable: false,
      },
    });
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
    assert.equal(await inspectWorkspace(boatConfig), expected);
  }

  nativeState = 'idle';
  health = 'degraded';
  assert.equal(await inspectWorkspace(boatConfig), 'unreachable');
  health = 'ok';
  access = 'view';
  await assert.rejects(inspectWorkspace(boatConfig));
  access = 'owner';
  nativeState = 'unknown-new-state';
  await assert.rejects(inspectWorkspace(boatConfig));
  const count = calls.length;
  await assert.rejects(inspectWorkspace({ ...boatConfig, BOAT_API_KEY: '' }));
  assert.equal(calls.length, count, 'missing configuration must not issue a request or fall back');
});

test('Docker adapter checks the real separate sandbox and rejects wrong authentication', async () => {
  const config = {
    WORKSPACE_BACKEND: 'docker',
    DOCKER_SANDBOX_URL: process.env.DOCKER_SANDBOX_URL,
    DOCKER_SANDBOX_TOKEN: process.env.DOCKER_SANDBOX_TOKEN,
  } satisfies Parameters<typeof inspectWorkspace>[0];

  assert.equal(await inspectWorkspace(config), 'running');
  await assert.rejects(inspectWorkspace({ ...config, DOCKER_SANDBOX_TOKEN: 'wrong-token' }));
});
