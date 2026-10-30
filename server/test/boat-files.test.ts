import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { FileError } from '@earendil-works/pi-durable/env';

import { readRemoteFile, remoteFileInfo } from '../src/tools/remote.ts';

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
