import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { BoatApi, Configuration } from '@boatdev/sdk';
import { CommandIdentity } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { SessionCreation as SessionCreationSchema, WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { ShellProgress } from '@cloud-swe/protocol/tools';
import { Effect } from 'effect';

import {
  dispatchRemoteCommand,
  readRemoteFile,
  remoteFileInfo,
  writeRemoteFile,
  type ToolsEnv,
} from '../src/tools/remote.ts';
import { commandPrefix, supervisorCommand } from '../src/tools/runner.ts';
import { provisionWorkspace, waitForWorkspace } from '../src/workspaces/index.ts';

// Billed: runs only with WORKSPACE_BACKEND=boat, provisions one sandbox and always deletes it.
const live = process.env.WORKSPACE_BACKEND === 'boat';
const apiKey = process.env.BOAT_API_KEY;

async function exited(env: ToolsEnv, workspace: WorkspaceRecord, identity: ReturnType<typeof CommandIdentity.parse>) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const json = await readRemoteFile(env, workspace, commandPrefix(identity) + '.json', AbortSignal.timeout(10_000));
      const progress = ShellProgress.parse(JSON.parse(json));

      if (progress.kind === 'exited') return progress;
    } catch {
      // The supervisor has not written its first record yet.
    }

    await setTimeout(1000);
  }

  throw new Error('Command did not exit');
}

test('the real Boat adapter reads, writes, runs and cancels commands', { skip: !live, timeout: 300_000 }, async () => {
  assert.ok(apiKey, 'Boat mode requires BOAT_API_KEY');
  const env = { BOAT_API_KEY: apiKey, WORKSPACE_BACKEND: 'boat' } as const;
  const boat = new BoatApi(new Configuration({ accessToken: apiKey, fetchApi: fetch }));

  const creation: SessionCreation = SessionCreationSchema.parse({
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

    const home = await remoteFileInfo(env, workspace, '.', signal());
    assert.ok(home.path.startsWith('/'), 'file info reports an absolute path');

    const path = home.path + '/live/nested/hello.txt';
    await writeRemoteFile(env, workspace, path, 'hello boat\n', signal());
    assert.equal(await readRemoteFile(env, workspace, path, signal()), 'hello boat\n');
    await assert.rejects(readRemoteFile(env, workspace, home.path + '/live/missing.txt', signal()), {
      code: 'not_found',
    });

    const identity = CommandIdentity.parse({
      workspaceId: creation.workspaceId,
      runnerGeneration: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
    });

    await dispatchRemoteCommand(
      env,
      workspace,
      supervisorCommand(identity, { command: 'printf live', timeoutSeconds: 60, cwd: home.path }),
      signal(),
    );
    const done = await exited(env, workspace, identity);
    assert.equal(done.kind === 'exited' && done.exitCode, 0);
    assert.equal(done.output, 'live');

    const slow = CommandIdentity.parse({ ...identity, operationId: crypto.randomUUID() });
    await dispatchRemoteCommand(
      env,
      workspace,
      supervisorCommand(slow, { command: 'sleep 300', timeoutSeconds: 600, cwd: home.path }),
      signal(),
    );
    await writeRemoteFile(env, workspace, commandPrefix(slow) + '.cancel', '', signal());
    const cancelled = await exited(env, workspace, slow);
    assert.equal(cancelled.kind === 'exited' && cancelled.termination, 'cancelled');
  } finally {
    await boat.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId });
  }
});
