import { Buffer } from 'node:buffer';

import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { CommandOperation, FileContent, ShellProgress } from '@cloud-swe/protocol/tools';

import type { ToolHost } from './host';
import { readRemoteFile } from './remote';
import { commandPrefix } from './runner';

export const unresolvedReason = 'Remote command outcome is unresolved; no automatic re-execution';

async function store(storage: Pick<DurableObjectStorage, 'put' | 'delete'>, operation: CommandOperation) {
  const id = operation.nativeTaskId;
  await storage.put('command:' + id, operation);

  if (operation.record.kind === 'exited' || operation.record.kind === 'not_started')
    await storage.delete('command-open:' + id);
  else await storage.put('command-open:' + id, id);
}

export async function saveCommand(host: ToolHost, operation: CommandOperation) {
  await host.storage.transaction((tx) => store(tx, operation));
}

export async function commandOperations(host: ToolHost) {
  const index = await host.storage.list<unknown>({ prefix: 'command-open:' });
  const keys = [...index.values()].map((id) => 'command:' + CommandOperation.shape.nativeTaskId.parse(id));

  if (keys.length === 0) return [];
  const saved = await host.storage.get<unknown>(keys);

  return [...saved.values()].map((raw) => CommandOperation.parse(raw));
}

export async function markUncertain(host: ToolHost, operation: CommandOperation) {
  return host.storage.transaction(async (tx) => {
    const current = CommandOperation.parse(await tx.get<unknown>('command:' + operation.nativeTaskId));

    if (current.record.kind === 'exited' || current.record.kind === 'not_started') return current;

    const next = CommandOperation.parse({
      ...current,
      record: { kind: 'uncertain', identity: current.record.identity, reason: unresolvedReason },
    });

    await store(tx, next);

    return next;
  });
}

export async function markNotStarted(host: ToolHost, operation: CommandOperation) {
  await saveCommand(
    host,
    CommandOperation.parse({
      ...operation,
      record: { kind: 'not_started', identity: operation.record.identity, reason: 'Cancelled before dispatch' },
    }),
  );
}

export async function requestInterruption(host: ToolHost, operation: CommandOperation) {
  return host.storage.transaction(async (tx) => {
    const current = CommandOperation.parse(await tx.get<unknown>('command:' + operation.nativeTaskId));
    const next = current.record.kind === 'exited' ? current : { ...current, cancelRequested: true };
    await store(tx, next);

    return next;
  });
}

async function completedProgress(host: ToolHost, operation: CommandOperation): Promise<ShellProgress> {
  if (operation.record.kind !== 'exited') throw new Error('Command is not terminal');

  const encoded = FileContent.parse({
    content: await host.storage.get<unknown>('command-output:' + operation.nativeTaskId),
  }).content;

  return ShellProgress.parse({
    kind: 'exited',
    identity: operation.record.identity,
    output: Buffer.from(encoded, 'base64').toString('utf8'),
    outputBytes: operation.outputBytes,
    exitCode: operation.record.exitCode,
    termination: operation.record.termination,
  });
}

export async function reconcileCommand(host: ToolHost, workspace: WorkspaceRecord, operation: CommandOperation) {
  if (operation.record.kind === 'exited') return { operation, progress: await completedProgress(host, operation) };
  const identity = operation.record.identity;

  const progress = ShellProgress.parse(
    JSON.parse(await readRemoteFile(host.env, workspace, commandPrefix(identity) + '.json', AbortSignal.timeout(5000))),
  );

  if (JSON.stringify(progress.identity) !== JSON.stringify(identity)) throw new Error('Remote job identity mismatch');

  const value = await host.storage.transaction(async (tx) => {
    const current = CommandOperation.parse(await tx.get<unknown>('command:' + operation.nativeTaskId));

    if (current.record.kind === 'exited') return current;

    const next = CommandOperation.parse({
      ...current,
      output: progress.output.slice(-8192),
      outputBytes: progress.outputBytes,
      record:
        progress.kind === 'exited'
          ? {
              kind: 'exited',
              identity,
              jobId: identity.operationId,
              exitCode: progress.exitCode,
              termination: progress.termination,
            }
          : { kind: 'running', identity, jobId: identity.operationId },
    });

    if (progress.kind === 'exited') {
      // Separate bounded blob: keep terminal output recoverable even after Boat loses /tmp.
      await tx.put('command-output:' + next.nativeTaskId, Buffer.from(progress.output).toString('base64'));
    }

    await store(tx, next);

    return next;
  });

  return { operation: value, progress };
}
