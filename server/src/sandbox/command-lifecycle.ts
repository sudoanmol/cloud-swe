/**
 * Path: server/src/sandbox/command-lifecycle.ts
 * Used by: server/src/sandbox/commands.ts, server/src/sessions/{keep-alive,thread}.ts, server/src/tools/registry.ts.
 * Purpose: Ends remote commands truthfully: interrupting them, finding what blocks a session, and the durable job that stops orphans no live Pi tool call owns.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import type { Session } from '@cloud-swe/protocol';
import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { CommandOperation } from '@cloud-swe/protocol/tools';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import { Effect } from 'effect';

import { PollingJob } from '../polling-job.ts';
import {
  commandOperations,
  isOpen,
  markLost,
  markUncertain,
  pollCommand,
  requestInterruption,
  deletedReason,
  STOPPING,
  unresolvedReason,
  writeCancelMarker,
} from './command-records.ts';
import { type ToolHost, toolWorkspace } from './host.ts';

export async function interruptCommand(
  host: ToolHost,
  workspace: WorkspaceRecord,
  initial: CommandOperation,
): Promise<boolean> {
  const operation = await requestInterruption(host, initial);

  if (!isOpen(operation)) return true;

  try {
    await writeCancelMarker(host, workspace, operation.record.identity);

    const { operation: stopped } = await Effect.runPromise(
      pollCommand(host, workspace, operation, { every: '100 millis', deadline: '8 seconds', limits: STOPPING }),
    );

    return !isOpen(stopped);
  } catch {
    await markUncertain(host, operation);

    return false;
  }
}

export async function interruptCommands(host: ToolHost, messageIds: readonly string[]): Promise<boolean> {
  const commands = (await commandOperations(host)).filter((op) => messageIds.includes(op.messageOperationId));

  if (commands.length === 0) return true;
  const workspace = await toolWorkspace(host);
  const results = await Promise.all(commands.map((op) => interruptCommand(host, workspace, op)));

  return results.every(Boolean);
}

async function ownedTasks(host: ToolHost) {
  const pi = await host.harness.pi();
  const root = await pi.root(BG);

  return pi.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, root.id);

    return [...(live.tools ?? []), ...(live.nestedTools ?? [])]
      .filter((slot) => slot.status !== 'done')
      .flatMap((slot) => (slot.taskId === undefined ? [] : [Number(slot.taskId)]));
  }, BG);
}

async function commandBlocker(host: ToolHost) {
  const owned = await ownedTasks(host);

  return (await commandOperations(host)).find(
    (op) => op.record.kind === 'uncertain' || op.record.cancelRequested || !owned.includes(op.nativeTaskId),
  );
}

export async function hasUnresolvedCommands(host: ToolHost): Promise<boolean> {
  return (await commandBlocker(host)) !== undefined;
}

export async function assertResolvedCommands(host: ToolHost): Promise<void> {
  if (await hasUnresolvedCommands(host)) throw new Error(unresolvedReason);
}

// Called outside DO admission locks. Pi has already moved on from these, so stop them and never start a replacement.
async function reconcileCommands(host: ToolHost): Promise<void> {
  const owned = await ownedTasks(host);
  const orphans = (await commandOperations(host)).filter((op) => !owned.includes(op.nativeTaskId));

  if (orphans.length === 0) return;
  const workspace = await toolWorkspace(host);
  await Promise.all(orphans.map((operation) => interruptCommand(host, workspace, operation)));
}

/** The sandbox was deleted and replaced, so every open command's process is gone. They end now, truthfully. */
export async function endCommandsOfDeletedSandbox(host: ToolHost): Promise<void> {
  await Promise.all((await commandOperations(host)).map((op) => markLost(host, op, deletedReason)));
}

/**
 * Resolve orphans before admitting new work, without letting a slow sandbox hold the request open.
 * Whatever is still unresolved keeps blocking admission, and the Thread's reconcile job retries it.
 */
export async function reconcileWithin(host: ToolHost, ms: number): Promise<void> {
  await Promise.race([reconcileCommands(host).catch(() => undefined), sleep(ms)]);
}

export async function commandRunState(host: ToolHost): Promise<Session['run'] | undefined> {
  const operation = await commandBlocker(host);

  if (!operation) return undefined;

  return {
    kind: 'uncertain',
    runId: operation.runId,
    operationId: operation.messageOperationId,
    reason: unresolvedReason,
  };
}

/**
 * Stops commands Pi no longer owns from a durable job, so no read route has to. It keeps checking while a command is
 * open: a running command still owned by Pi stays open.
 */
export const commandReconciler = (host: () => ToolHost) =>
  new PollingJob({
    capability: 'command-reconciler',
    job: 'reconcile',
    async step() {
      await reconcileCommands(host());

      return (await commandOperations(host())).length > 0;
    },
    everyMs: () => 5000,
  });
