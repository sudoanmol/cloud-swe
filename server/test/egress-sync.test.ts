/**
 * Path: server/test/egress-sync.test.ts
 * Used by: pnpm test.
 * Purpose: syncSandbox without a sandbox: parallel syncs of one workspace apply once, an unchanged hash makes no calls, a failed apply warns and retries on the next sync, and the network token rotates into the daemon config like the Git token.
 */

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { networkAuthorization, refreshNetworkAccessIfNeeded, syncSandbox } from '../src/sandbox/egress.ts';
import { fakeSession, memoryStorage } from './fakes.ts';

const ROOT = '/workspace/00000000-0000-4000-8000-000000000000';

// Sync uses these host fields only; all remote calls go to the local fetch stub below. With `hosts`, egress is on.
function syncRig(hosts: string[] = []) {
  const session = fakeSession();
  const workspace = { id: session.workspace.id, sessionId: session.id, provider: 'docker', sandboxId: 'test' };
  let value = 'first';
  let paused = false;
  const diagnostics: unknown[] = [];

  const host = {
    env: {
      WORKSPACE_BACKEND: 'docker',
      DOCKER_SANDBOX_URL: 'http://sandbox.test',
      DOCKER_SANDBOX_TOKEN: 'dummy-test-token',
      DOCKER_SANDBOX_ROOT: '1',
      PUBLIC_URL: 'https://worker.test',
      CREDENTIALS: {
        idFromName: () => 'personal',
        get: () => ({ sandboxView: async () => ({ variables: { FOO: value }, placeholders: {}, hosts }) }),
      },
      CATALOG: {
        idFromName: () => 'account',
        get: () => ({
          workspaceState: async () => (paused ? 'stopped' : 'running'),
          workspaceBinding: async () => {
            if (paused) throw new Error('The session workspace is stopped');

            return workspace;
          },
        }),
      },
    },
    storage: memoryStorage(new Map([['session', session]])),
  };

  // SAFETY: syncSandbox only uses the host/storage/API members above, and validates its stored records itself.
  const sync = () =>
    syncSandbox(
      host as never,
      workspace as never,
      {
        diagnostic: () => {
          diagnostics.push('warning');
        },
      } as never,
    );

  return {
    sync,
    diagnostics,
    change: () => {
      value = 'second';
    },
    // SAFETY: as for sync.
    refresh: () => refreshNetworkAccessIfNeeded(host as never),
    // SAFETY: networkAuthorization reads storage and the catalog stub above only.
    authorized: async (token: string) => (await networkAuthorization(host as never, token)).ok,
    pause: (on: boolean) => {
      paused = on;
    },
    // The row as the code before rotation stored it: one token that never expired.
    seedLegacy: (token: string) => host.storage.put('netAccess', { workspaceId: workspace.id, token }),
  };
}

/** Answers the Docker file and exec calls, and keeps each token written to the daemon config. */
function stubSandbox(t: TestContext, configs: string[] = [], fail = () => false) {
  const calls: { path: string; body: string }[] = [];

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = String(init?.body ?? '');
    calls.push({ path, body });

    if (path.endsWith('/file')) {
      const file = JSON.parse(body);

      if (String(file.path).endsWith('egress.json.next')) configs.push(JSON.parse(file.content).token);

      return Response.json({ written: true });
    }

    if (path.endsWith('/exec'))
      return Response.json({ exitCode: fail() ? 1 : 0, stdout: fail() ? 'stale' : 'applied\n' });

    return Response.json({ name: '.', path: ROOT, kind: 'directory', size: 0, mtimeMs: 0 });
  });

  return calls;
}

test('parallel syncs apply one change once; a failed apply warns and retries next time', async (t) => {
  let fail = false;
  const calls = stubSandbox(t, [], () => fail);
  const rig = syncRig();
  const paths = await Promise.all(Array.from({ length: 10 }, () => rig.sync()));
  assert.ok(paths.every((path) => path === `${ROOT}/.cloud-swe/env.json`));
  assert.equal(calls.filter(({ path }) => path.endsWith('/file')).length, 1);
  assert.equal(calls.filter(({ path }) => path.endsWith('/exec')).length, 1);
  const unchanged = calls.length;
  await rig.sync();
  assert.equal(calls.length, unchanged);

  rig.change();
  fail = true;
  assert.equal(await rig.sync(), paths[0]);
  assert.equal(rig.diagnostics.length, 1);
  fail = false;
  assert.equal(await rig.sync(), paths[0]);
  assert.equal(calls.filter(({ path }) => path.endsWith('/file')).length, 3);
  assert.equal(calls.filter(({ path }) => path.endsWith('/exec')).length, 3);
});

test('the network token rotates into the daemon config; an old one works until its own expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const minutes = (count: number) => t.mock.timers.tick(count * 60_000);
  const configs: string[] = [];
  const calls = stubSandbox(t, configs);
  const rig = syncRig(['api.example.test']);

  await rig.sync();
  const [first = ''] = configs;
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.ok(await rig.authorized(first));
  assert.equal(await rig.authorized('f'.repeat(64)), false);

  // Far from expiry: neither a command nor the keep-alive touches the sandbox.
  const quiet = calls.length;
  await rig.sync();
  await rig.refresh();
  assert.equal(calls.length, quiet);

  // Within 20 min of expiry, the keep-alive rotates it with no command running.
  minutes(41);
  await rig.refresh();
  const second = configs.at(-1) ?? '';
  assert.equal(configs.length, 2);
  assert.notEqual(second, first);
  assert.ok(await rig.authorized(first), 'a request already sent with the old token still passes');
  assert.ok(await rig.authorized(second));

  minutes(20);
  assert.equal(await rig.authorized(first), false, 'the old token dies at its own expiry');
  assert.ok(await rig.authorized(second));

  // Paused past every expiry: the keep-alive can't reach it, and its last token has expired.
  rig.pause(true);
  minutes(120);
  await rig.refresh();
  assert.equal(configs.length, 2);
  assert.equal(await rig.authorized(second), false);

  // Resumed: the keep-alive's tick puts a live token in place before any command runs.
  rig.pause(false);
  await rig.refresh();
  const third = configs.at(-1) ?? '';
  assert.equal(configs.length, 3);
  assert.ok(await rig.authorized(third));
  assert.equal(await rig.authorized(second), false);
});

test('a network token from before rotation is refused and replaced on the next sync', async (t) => {
  const configs: string[] = [];
  stubSandbox(t, configs);
  const rig = syncRig(['api.example.test']);
  const legacy = 'a'.repeat(64);
  await rig.seedLegacy(legacy);

  assert.equal(await rig.authorized(legacy), false);
  await rig.sync();
  assert.equal(configs.length, 1);
  assert.notEqual(configs[0], legacy);
  assert.ok(await rig.authorized(configs[0] ?? ''));
});
