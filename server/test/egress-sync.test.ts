/**
 * Path: server/test/egress-sync.test.ts
 * Used by: pnpm test.
 * Purpose: syncSandbox without a sandbox: parallel syncs of one workspace apply once, an unchanged hash makes no calls, and a failed apply warns and retries on the next sync.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { syncSandbox } from '../src/sandbox/egress.ts';

// Sync uses these host fields only; all remote calls go to the local fetch stub below.
function syncRig() {
  const now = new Date().toISOString();
  const workspace = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), provider: 'docker', sandboxId: 'test' };

  const session = {
    id: workspace.sessionId,
    runtime: { conversationId: '1' },
    model: { provider: 'anthropic', id: 'm' },
    workspace: { id: workspace.id, provider: 'docker', state: 'running' },
    environment: 'dev',
    capabilities: { submitMessage: true, cancelRun: true, tools: [], approvals: true, delegation: false },
    run: { kind: 'idle' },
    createdAt: now,
    updatedAt: now,
  };

  const rows = new Map<string, unknown>([['session', session]]);
  let value = 'first';
  const diagnostics: unknown[] = [];

  const host = {
    env: {
      WORKSPACE_BACKEND: 'docker',
      DOCKER_SANDBOX_URL: 'http://sandbox.test',
      DOCKER_SANDBOX_TOKEN: 'dummy-test-token',
      CREDENTIALS: {
        idFromName: () => 'personal',
        get: () => ({ sandboxView: async () => ({ variables: { FOO: value }, placeholders: {}, hosts: [] }) }),
      },
    },
    storage: {
      get: async (key: string) => structuredClone(rows.get(key)),
      put: async <T>(key: string, record: T) => {
        rows.set(key, structuredClone(record));
      },
    },
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
  };
}

test('parallel syncs apply one change once; a failed apply warns and retries next time', async (t) => {
  const calls: { path: string; body: string }[] = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: String(init?.body ?? '') });

    if (path.endsWith('/file')) return Response.json({ written: true });

    if (path.endsWith('/exec')) return Response.json({ exitCode: fail ? 1 : 0, stdout: fail ? 'stale' : 'applied\n' });

    return Response.json({
      name: '.',
      path: '/workspace/00000000-0000-4000-8000-000000000000',
      kind: 'directory',
      size: 0,
      mtimeMs: 0,
    });
  });
  const rig = syncRig();
  const paths = await Promise.all(Array.from({ length: 10 }, () => rig.sync()));
  assert.ok(paths.every((path) => path === '/workspace/00000000-0000-4000-8000-000000000000/.cloud-swe/env.json'));
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
