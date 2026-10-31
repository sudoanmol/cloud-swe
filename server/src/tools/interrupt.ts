import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { CommandOperation } from '@cloud-swe/protocol/tools';
import { Effect } from 'effect';

import {
  commandOperations,
  isOpen,
  markUncertain,
  pollCommand,
  requestInterruption,
  STOPPING,
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
