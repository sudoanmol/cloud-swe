import { setTimeout as sleep } from 'node:timers/promises';

import type { Session } from '@cloud-swe/protocol';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';

import { commandOperations, markLost, stoppedReason, unresolvedReason } from './command-records.ts';
import { type ToolHost, toolWorkspace } from './host.ts';
import { interruptCommand } from './interrupt.ts';

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
export async function reconcileCommands(host: ToolHost): Promise<void> {
  const owned = await ownedTasks(host);
  const orphans = (await commandOperations(host)).filter((op) => !owned.includes(op.nativeTaskId));

  if (orphans.length === 0) return;
  const workspace = await toolWorkspace(host);
  await Promise.all(orphans.map((operation) => interruptCommand(host, workspace, operation)));
}

/** The sandbox stopped or was replaced, so every open command's process is gone. They end now, truthfully. */
export async function endCommandsOfStoppedSandbox(host: ToolHost): Promise<void> {
  await Promise.all((await commandOperations(host)).map((op) => markLost(host, op, stoppedReason)));
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
