import type { Session } from '@cloud-swe/protocol';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';

import { commandOperations, markUncertain, reconcileCommand, unresolvedReason } from './command-records';
import { type ToolHost, toolWorkspace } from './host';
import { interruptCommand } from './interrupt';

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
    (op) => op.record.kind === 'uncertain' || op.cancelRequested || !owned.includes(op.nativeTaskId),
  );
}

export async function assertResolvedCommands(host: ToolHost): Promise<void> {
  if (await commandBlocker(host)) throw new Error(unresolvedReason);
}

// Called outside DO admission locks. Losing the caller never starts a replacement command.
export async function reconcileCommands(host: ToolHost): Promise<void> {
  const owned = await ownedTasks(host);

  const commands = (await commandOperations(host)).filter(
    (op) => op.record.kind === 'uncertain' || !owned.includes(op.nativeTaskId),
  );

  if (commands.length === 0) return;
  const workspace = await toolWorkspace(host);
  await Promise.all(
    commands.map(async (operation) => {
      try {
        const result = await reconcileCommand(host, workspace, operation);

        // Pi has already removed this invocation; stop work left by an ended/failed parent.
        if (result.progress.kind === 'running' && !owned.includes(operation.nativeTaskId)) {
          await interruptCommand(host, workspace, result.operation);
        }
      } catch {
        await markUncertain(host, operation);
      }
    }),
  );
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
