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

test('Boat errors map to file errors by status and never expose upstream bodies', async (t) => {
  let status = 404;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: false, error: { code: 'file_not_found', message: 'secret upstream detail' } }, { status }),
  );
  const signal = AbortSignal.timeout(5000);

  await assert.rejects(readRemoteFile(env, workspace, 'missing.txt', signal), { code: 'not_found' });
  await assert.rejects(remoteFileInfo(env, workspace, 'missing.txt', signal), { code: 'not_found' });

  status = 500;
  await assert.rejects(
    readRemoteFile(env, workspace, 'missing.txt', signal),
    (error) => error instanceof FileError && error.code === 'unknown' && !error.message.includes('secret'),
  );
});
