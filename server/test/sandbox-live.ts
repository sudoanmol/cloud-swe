/**
 * Path: server/test/sandbox-live.ts
 * Used by: server/test/{e2b-live.test,workspace.test}.ts.
 * Purpose: What every real sandbox provider must do through the adapter, so providers stay at parity on the same checks.
 */

import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

import { CommandIdentity } from '@cloud-swe/protocol';
import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { ShellProgress } from '@cloud-swe/protocol/tools';
import { Effect } from 'effect';

import {
  createRemoteDirectory,
  dispatchRemoteCommand,
  readRemoteBytes,
  readRemoteFile,
  remoteFileInfo,
  type ToolsEnv,
  writeRemoteFile,
} from '../src/sandbox/remote.ts';
import { commandPrefix, supervisorCommand } from '../src/sandbox/runner.ts';
import { listSandboxes } from '../src/workspaces/index.ts';

const signal = () => AbortSignal.timeout(20_000);

/**
 * The orphan sweep's view of a provider: a Catalog's listing holds the sandbox stamped with its ID, with its real start
 * time, and another Catalog's listing doesn't. Only lists; it never deletes.
 */
export async function checkSandboxListing(
  env: Parameters<typeof listSandboxes>[0],
  catalogId: string,
  sandboxId: string,
): Promise<void> {
  const list = (catalog: string) => Effect.runPromise(listSandboxes(env, catalog));
  let listed = await list(catalogId);

  // E2B's list takes up to about half a second to show a new sandbox.
  for (let attempt = 0; listed.length === 0 && attempt < 40; attempt++) {
    await setTimeout(250);
    listed = await list(catalogId);
  }

  assert.deepEqual(
    listed.map((sandbox) => sandbox.sandboxId),
    [sandboxId],
  );
  assert.ok(Math.abs(Date.now() - (listed[0]?.startedAt ?? 0)) < 600_000, 'the listing carries the start time');
  assert.deepEqual(await list(crypto.randomUUID()), [], 'another Catalog sees none of these sandboxes');
}

export async function commandExited(
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  identity: ReturnType<typeof CommandIdentity.parse>,
) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const json = await readRemoteFile(env, workspace, commandPrefix(identity) + '.json', signal());
      const progress = ShellProgress.parse(JSON.parse(json));

      if (progress.kind === 'exited') return progress;
    } catch {
      // The supervisor has not written its first record yet.
    }

    await setTimeout(1000);
  }

  throw new Error('Command did not exit');
}

export const newCommand = (workspace: WorkspaceRecord) =>
  CommandIdentity.parse({ workspaceId: workspace.id, operationId: crypto.randomUUID() });

/** Files, error mapping, one command to completion and one cancelled, on a sandbox that's already running. */
export async function checkSandboxAdapter(env: ToolsEnv, workspace: WorkspaceRecord): Promise<void> {
  const home = await remoteFileInfo(env, workspace, '.', signal());
  assert.ok(home.path.startsWith('/'), 'file info reports an absolute path');
  assert.equal(home.kind, 'directory');

  const path = home.path + '/live/nested/hello.txt';
  await writeRemoteFile(env, workspace, path, 'hello\n', signal());
  assert.equal(await readRemoteFile(env, workspace, path, signal()), 'hello\n');
  assert.equal(Buffer.from(await readRemoteBytes(env, workspace, path, signal())).toString(), 'hello\n');
  assert.equal((await remoteFileInfo(env, workspace, path, signal())).kind, 'file');
  assert.equal((await remoteFileInfo(env, workspace, path, signal())).size, 6);

  await createRemoteDirectory(env, workspace, home.path + '/live/made', signal());
  assert.equal((await remoteFileInfo(env, workspace, home.path + '/live/made', signal())).kind, 'directory');

  await assert.rejects(readRemoteFile(env, workspace, home.path + '/live/missing.txt', signal()), {
    code: 'not_found',
  });
  await assert.rejects(remoteFileInfo(env, workspace, home.path + '/live/missing.txt', signal()), {
    code: 'not_found',
  });
  await assert.rejects(readRemoteFile(env, workspace, home.path, signal()), { code: 'invalid' });

  // Cancel markers and agents write under /tmp, and a retry writes the same path again.
  const shared = `/tmp/cloud-swe-live-${crypto.randomUUID()}`;
  await writeRemoteFile(env, workspace, shared, 'first', signal());
  await writeRemoteFile(env, workspace, shared, 'second', signal());
  assert.equal(await readRemoteFile(env, workspace, shared, signal()), 'second');

  const identity = newCommand(workspace);

  await dispatchRemoteCommand(
    env,
    workspace,
    supervisorCommand(identity, { command: 'printf live; exit 3', timeoutSeconds: 60, cwd: home.path }),
    signal(),
  );
  const done = await commandExited(env, workspace, identity);
  assert.equal(done.kind === 'exited' && done.exitCode, 3);
  assert.equal(done.output, 'live');

  const slow = newCommand(workspace);

  await dispatchRemoteCommand(
    env,
    workspace,
    supervisorCommand(slow, { command: 'sleep 300', timeoutSeconds: 600, cwd: home.path }),
    signal(),
  );
  await writeRemoteFile(env, workspace, commandPrefix(slow) + '.cancel', '', signal());
  const cancelled = await commandExited(env, workspace, slow);
  assert.equal(cancelled.kind === 'exited' && cancelled.termination, 'cancelled');
}
