/**
 * Path: server/test/boat-live.test.ts
 * Used by: pnpm test.
 * Purpose: Exercises the real Boat adapter; runs only with pnpm test --boat, and is billed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BoatApi, Configuration } from '@boatdev/sdk';
import {
  type SessionCreation,
  SessionCreation as SessionCreationSchema,
  WorkspaceRecord,
} from '@cloud-swe/protocol/storage';
import { Effect } from 'effect';

import { readRemoteFile, remoteFileInfo, writeRemoteFile } from '../src/sandbox/remote.ts';
import { provisionWorkspace, waitForWorkspace } from '../src/workspaces/index.ts';
import { checkSandboxAdapter } from './sandbox-live.ts';

// Billed: runs only with WORKSPACE_BACKEND=boat, provisions one sandbox and always deletes it.
const live = process.env.WORKSPACE_BACKEND === 'boat';
const apiKey = process.env.BOAT_API_KEY;

test('the real Boat adapter reads, writes, runs and cancels commands', { skip: !live, timeout: 300_000 }, async () => {
  assert.ok(apiKey, 'Boat mode requires BOAT_API_KEY');
  const env = { BOAT_API_KEY: apiKey, WORKSPACE_BACKEND: 'boat' } as const;
  const boat = new BoatApi(new Configuration({ accessToken: apiKey, fetchApi: fetch }));

  const creation: SessionCreation = SessionCreationSchema.parse({
    request: {
      operationId: crypto.randomUUID(),
      environment: 'base',
      model: { provider: 'anthropic', id: 'configured-model' },
    },
    sessionId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });

  const sandboxId = await Effect.runPromise(provisionWorkspace(env, creation));

  try {
    assert.equal(await Effect.runPromise(waitForWorkspace(env, sandboxId)), 'running');

    const workspace = WorkspaceRecord.parse({
      id: creation.workspaceId,
      sessionId: creation.sessionId,
      provider: 'boat',
      sandboxId,
    });

    const signal = () => AbortSignal.timeout(20_000);

    await checkSandboxAdapter(env, workspace);

    const home = await remoteFileInfo(env, workspace, '.', signal());
    const path = home.path + '/live/nested/hello.txt';
    await writeRemoteFile(env, workspace, path, 'hello boat\n', signal());
    assert.equal(await readRemoteFile(env, workspace, path, signal()), 'hello boat\n');

    // Writes create their parent with mode 700; that must not tighten an existing shared directory.
    const tmpMode = (await boat.getFileInfo({ sandboxId, path: '/tmp' })).mode;
    await writeRemoteFile(env, workspace, '/tmp/cloud-swe-live-mode-check', 'x', signal());
    assert.equal((await boat.getFileInfo({ sandboxId, path: '/tmp' })).mode, tmpMode);
  } finally {
    await boat.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId });
  }

  // Cancel treats a missing sandbox as stopped, so a deleted one must report not_found.
  const gone = WorkspaceRecord.parse({
    id: creation.workspaceId,
    sessionId: creation.sessionId,
    provider: 'boat',
    sandboxId,
  });

  await assert.rejects(readRemoteFile(env, gone, '/tmp/anything', AbortSignal.timeout(20_000)), { code: 'not_found' });
});
