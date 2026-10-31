/**
 * Path: server/test/workspace-backends.test.ts
 * Used by: pnpm test.
 * Purpose: Boat and Docker response schemas, and how Boat file errors map to tool errors.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { FileError } from '@earendil-works/pi-durable/env';

import { readRemoteFile, remoteFileInfo } from '../src/tools/remote.ts';
import { BoatApiError, BoatSandboxCreated, BoatSandboxList } from '../src/workspaces/boat.ts';
import { DockerWorkspaceInfo } from '../src/workspaces/docker.ts';

const id = 'fa879d6e-bd71-48df-a621-f070c8df45da';

test('sandbox identities are validated per backend', () => {
  assert.ok(
    BoatSandboxCreated.safeParse({ ok: true, type: 'sandbox.created', sandbox: { id: 'bx_23456789' } }).success,
  );
  assert.equal(
    BoatSandboxCreated.safeParse({ ok: true, type: 'sandbox.created', sandbox: { id: 'other' } }).success,
    false,
  );
  assert.ok(
    DockerWorkspaceInfo.safeParse({ provider: 'docker', id, state: 'running', root: `/workspace/${id}` }).success,
  );
  assert.equal(
    DockerWorkspaceInfo.safeParse({ provider: 'docker', id, state: 'running', root: '/workspace' }).success,
    false,
  );
});

test('sandbox recovery validates identities and requires pagination metadata', () => {
  const response = {
    ok: true,
    type: 'sandbox.list',
    sandboxes: [{ id: 'bx_23456789', name: 'cloud-swe-' + id }],
    pageInfo: { hasMore: false },
  };

  assert.ok(BoatSandboxList.safeParse(response).success);
  assert.equal(BoatSandboxList.safeParse({ ...response, pageInfo: undefined }).success, false);
  assert.equal(BoatSandboxList.safeParse({ ...response, sandboxes: [{ id: 'bad', name: 'test' }] }).success, false);
});

test('Boat error envelopes require a code', () => {
  assert.equal(
    BoatApiError.parse({ ok: false, error: { code: 'idempotency_in_progress', message: 'Creating' } }).error.code,
    'idempotency_in_progress',
  );

  for (const raw of [
    {},
    { ok: false, error: { code: 409 } },
    { ok: true, error: { code: 'idempotency_in_progress' } },
  ]) {
    assert.equal(BoatApiError.safeParse(raw).success, false);
  }
});

const workspace = WorkspaceRecord.parse({
  id: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  provider: 'boat',
  sandboxId: 'bx_23456789',
});

const env = { BOAT_API_KEY: 'boat_test_transport_only' };

const boatError = (status: number, code: string, message: string) =>
  Response.json(
    { ok: false, type: 'sandbox.error', status, code, message, error: { code, message, status } },
    { status },
  );

test('Boat errors map to file errors using its real responses and never expose upstream bodies', async (t) => {
  let response = () => boatError(400, 'sandbox_direct_failed', "ENOENT: no such file or directory, stat '/tmp/a'");
  t.mock.method(globalThis, 'fetch', async () => response());
  const signal = AbortSignal.timeout(5000);

  await assert.rejects(readRemoteFile(env, workspace, 'missing.txt', signal), { code: 'not_found' });

  response = () => boatError(400, 'sandbox_direct_failed', 'No such file or directory: /tmp/a');
  await assert.rejects(remoteFileInfo(env, workspace, 'missing.txt', signal), { code: 'not_found' });

  response = () => boatError(404, 'not_found', 'not_found');
  await assert.rejects(readRemoteFile(env, workspace, 'gone.txt', signal), { code: 'not_found' });

  response = () => boatError(400, 'invalid_path', 'Path must resolve under /home/user or /tmp');
  await assert.rejects(readRemoteFile(env, workspace, '/etc/hostname', signal), { code: 'invalid' });

  response = () => boatError(400, 'sandbox_direct_failed', 'Path is not a file.');
  await assert.rejects(readRemoteFile(env, workspace, '/tmp', signal), { code: 'invalid' });

  response = () => boatError(500, 'internal', 'secret upstream detail');
  await assert.rejects(
    readRemoteFile(env, workspace, 'missing.txt', signal),
    (error) => error instanceof FileError && error.code === 'unknown' && !error.message.includes('secret'),
  );
});
