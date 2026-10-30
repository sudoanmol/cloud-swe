import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { CommandOperation } from '@cloud-swe/protocol/tools';
import { Effect, Schedule } from 'effect';

import { commandOperations, markUncertain, reconcileCommand, requestInterruption } from './command-records';
import { type ToolHost, toolWorkspace } from './host';
import { writeRemoteFile } from './remote';
import { commandPrefix } from './runner';

export async function interruptCommand(
  host: ToolHost,
  workspace: WorkspaceRecord,
  initial: CommandOperation,
): Promise<boolean> {
  let operation = await requestInterruption(host, initial);

  if (operation.record.kind === 'exited') return true;

  try {
    await writeRemoteFile(
      host.env,
      workspace,
      commandPrefix(operation.record.identity) + '.cancel',
      'cancel',
      AbortSignal.timeout(5000),
    );

    const progress = await Effect.runPromise(
      Effect.tryPromise(async () => {
        const result = await reconcileCommand(host, workspace, operation);
        operation = result.operation;

        return result.progress;
      }).pipe(
        Effect.retry({ times: 10, schedule: Schedule.spaced('100 millis') }),
        Effect.repeat({ schedule: Schedule.spaced('100 millis'), while: (progress) => progress.kind === 'running' }),
        Effect.timeout('8 seconds'),
      ),
    );

    return progress.kind === 'exited';
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
