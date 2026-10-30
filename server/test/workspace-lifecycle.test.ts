import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { deleteWorkspace, inspectWorkspace, renewWorkspace, resumeWorkspace } from '../src/workspaces/index.ts';
import { workspaceSettings } from '../src/workspaces/settings.ts';

const sandboxId = 'bx_23456789';
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
