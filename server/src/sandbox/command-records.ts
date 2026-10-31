/**
 * Path: server/src/sandbox/command-records.ts
 * Used by: server/src/sandbox/{command-lifecycle,commands}.ts, server/src/sessions/{keep-alive,thread}.ts, server/src/tools/registry.ts.
 * Purpose: The durable command record and its state machine: storage, cancel markers and the poll that ends every command.
 */

import { Buffer } from 'node:buffer';

import type { CommandRecord } from '@cloud-swe/protocol';
import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { CommandOperation, FileContent, type OpenCommandOperation, ShellProgress } from '@cloud-swe/protocol/tools';
import { FileError } from '@earendil-works/pi-durable/env';
import { type Duration, Effect, Schedule } from 'effect';

import { catalogStub } from '../env.ts';
import { readParsed } from '../storage.ts';
import type { ToolHost } from './host.ts';
import { readRemoteFile, writeRemoteFile } from './remote.ts';
import { commandPrefix } from './runner.ts';

export const unresolvedReason = 'Remote command outcome is unresolved; no automatic re-execution';

/** How long a command may show no progress before it is declared lost. */
type ProgressLimits = { missingMs: number; frozenMs: number };

const WATCHING: ProgressLimits = { missingMs: 15_000, frozenMs: 15_000 };

// A cancel marker is already written: the supervisor saves before checking it, so a missing file cannot start later.
export const STOPPING: ProgressLimits = { missingMs: 0, frozenMs: 5000 };

// Boat outages are retried until the caller's deadline; they never prove a command is gone.
const READ_BACKOFF = Schedule.min([Schedule.exponential('200 millis'), Schedule.spaced('5 seconds')]);

export function isOpen(operation: CommandOperation): operation is OpenCommandOperation {
  return ['prepared', 'running', 'uncertain'].includes(operation.record.kind);
}

type Reader = Pick<DurableObjectStorage, 'get'>;

export async function readCommand(storage: Reader, taskId: number): Promise<CommandOperation | undefined> {
  return readParsed(storage, 'command:' + taskId, CommandOperation);
}

async function requireCommand(storage: Reader, taskId: number): Promise<CommandOperation> {
  return CommandOperation.parse(await storage.get<unknown>('command:' + taskId));
}

async function store(storage: Pick<DurableObjectStorage, 'put' | 'delete'>, operation: CommandOperation) {
  const id = operation.nativeTaskId;
  await storage.put('command:' + id, operation);

  if (isOpen(operation)) await storage.put('command-open:' + id, id);
  else await storage.delete('command-open:' + id);
}

export async function saveCommand(host: ToolHost, operation: CommandOperation) {
  await host.storage.transaction((tx) => store(tx, operation));
}

export async function commandOperations(host: ToolHost) {
  const index = await host.storage.list<unknown>({ prefix: 'command-open:' });
  const keys = [...index.values()].map((id) => 'command:' + CommandOperation.shape.nativeTaskId.parse(id));

  if (keys.length === 0) return [];
  const saved = await host.storage.get<unknown>(keys);

  return [...saved.values()].flatMap((raw) => {
    const operation = CommandOperation.parse(raw);

    return isOpen(operation) ? [operation] : [];
  });
}

export async function markUncertain(host: ToolHost, operation: CommandOperation) {
  return host.storage.transaction(async (tx) => {
    const current = await requireCommand(tx, operation.nativeTaskId);

    if (!isOpen(current)) return current;
    const next = { ...current, record: { ...current.record, kind: 'uncertain' as const, reason: unresolvedReason } };
    await store(tx, next);

    return next;
  });
}

export const stoppedReason =
  'The sandbox stopped while the command was running, which ended it; it may have partially run and was not retried';

/** The command's process is known to be gone, so it ends here instead of staying open and unresolved. */
export async function markLost(host: ToolHost, operation: CommandOperation, reason: string) {
  return host.storage.transaction(async (tx) => {
    const current = await requireCommand(tx, operation.nativeTaskId);

    if (!isOpen(current)) return current;
    const { output, outputBytes } = current.record;

    const next: CommandOperation = {
      ...current,
      record: { kind: 'lost', identity: current.record.identity, output, outputBytes, reason },
    };

    await store(tx, next);

    return next;
  });
}

export async function markNotStarted(host: ToolHost, operation: CommandOperation) {
  await saveCommand(host, {
    ...operation,
    record: { kind: 'not_started', identity: operation.record.identity, reason: 'Cancelled before dispatch' },
  });
}

export async function requestInterruption(host: ToolHost, operation: CommandOperation) {
  return host.storage.transaction(async (tx) => {
    const current = await requireCommand(tx, operation.nativeTaskId);

    if (!isOpen(current)) return current;
    const next = { ...current, record: { ...current.record, cancelRequested: true } };
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
    outputBytes: operation.record.outputBytes,
    exitCode: operation.record.exitCode,
    termination: operation.record.termination,
  });
}

export async function writeCancelMarker(
  host: ToolHost,
  workspace: WorkspaceRecord,
  identity: CommandRecord['identity'],
) {
  try {
    await writeRemoteFile(
      host.env,
      workspace,
      commandPrefix(identity) + '.cancel',
      'cancel',
      AbortSignal.timeout(5000),
    );
  } catch (error) {
    // A missing sandbox runs nothing, so there is nothing left to stop.
    if (!(error instanceof FileError && error.code === 'not_found')) throw error;
  }
}

// The sandbox's shell can write this file, so anything unreadable counts as no progress rather than a failure.
async function readProgress(host: ToolHost, workspace: WorkspaceRecord, identity: CommandRecord['identity']) {
  let text: string;

  try {
    text = await readRemoteFile(host.env, workspace, commandPrefix(identity) + '.json', AbortSignal.timeout(5000));
  } catch (error) {
    if (error instanceof FileError && error.code === 'not_found') return null;
    throw error;
  }

  try {
    const progress = ShellProgress.parse(JSON.parse(text));

    return JSON.stringify(progress.identity) === JSON.stringify(identity) ? progress : null;
  } catch {
    return null;
  }
}

function isAdvanced(progress: ShellProgress | null, heartbeat: number) {
  return progress?.kind === 'exited' || (progress !== null && progress.heartbeat > heartbeat);
}

async function reconcileCommand(
  host: ToolHost,
  workspace: WorkspaceRecord,
  operation: CommandOperation,
  limits: ProgressLimits = WATCHING,
): Promise<{ operation: CommandOperation; progress: ShellProgress | null }> {
  if (operation.record.kind === 'exited') return { operation, progress: await completedProgress(host, operation) };

  if (!isOpen(operation)) return { operation, progress: null };
  const { identity, heartbeat, lastSeenAt } = operation.record;
  let progress: ShellProgress | null;

  try {
    progress = await readProgress(host, workspace, identity);
  } catch (error) {
    // A stopped sandbox kills its commands for good. Anything else is an outage, retried by the caller.
    const state = await catalogStub(host.env).workspaceState(workspace.sessionId, workspace.id, true);

    if (state !== 'stopped' && state !== 'deleted') throw error;

    return { operation: await markLost(host, operation, stoppedReason), progress: null };
  }

  const advanced = isAdvanced(progress, heartbeat);
  const silentMs = Date.now() - lastSeenAt;
  const silenced = !advanced && silentMs >= (progress === null ? limits.missingMs : limits.frozenMs);

  if (!advanced && !silenced) return { operation, progress };

  // Before giving up, stop a supervisor that is merely slow or has not started yet.
  if (silenced) await writeCancelMarker(host, workspace, identity);

  const value = await host.storage.transaction(async (tx) => {
    const current = await requireCommand(tx, operation.nativeTaskId);

    if (!isOpen(current)) return current;
    const { cancelRequested, output, outputBytes } = current.record;

    if (silenced) {
      const next: CommandOperation = {
        ...current,
        record: {
          kind: 'lost',
          identity,
          output,
          outputBytes,
          reason: 'Remote command stopped reporting; it may have partially run and was not retried',
        },
      };

      await store(tx, next);

      return next;
    }

    if (progress === null) return current;
    const retained = { output: progress.output.slice(-8192), outputBytes: progress.outputBytes };

    if (progress.kind === 'exited') {
      // Separate bounded blob: keep terminal output recoverable even after Boat loses /tmp.
      await tx.put('command-output:' + current.nativeTaskId, Buffer.from(progress.output).toString('base64'));
    }

    const next: CommandOperation = {
      ...current,
      record:
        progress.kind === 'exited'
          ? { ...retained, kind: 'exited', identity, exitCode: progress.exitCode, termination: progress.termination }
          : {
              ...retained,
              kind: 'running',
              identity,
              cancelRequested,
              heartbeat: progress.heartbeat,
              lastSeenAt: Date.now(),
            },
    };

    await store(tx, next);

    return next;
  });

  return { operation: value, progress };
}

/** Follows one remote job until it settles. Fails only when a deadline was given and passes first. */
export function pollCommand(
  host: ToolHost,
  workspace: WorkspaceRecord,
  initial: CommandOperation,
  options: {
    every: Duration.Input;
    deadline?: Duration.Input;
    limits?: ProgressLimits;
    onProgress?: (progress: ShellProgress) => Promise<void>;
  },
) {
  let operation = initial;

  const poll = Effect.tryPromise(async () => {
    const result = await reconcileCommand(host, workspace, operation, options.limits);
    operation = result.operation;

    if (result.progress) await options.onProgress?.(result.progress);

    return result;
  }).pipe(
    Effect.retry({ schedule: READ_BACKOFF }),
    Effect.repeat({ schedule: Schedule.spaced(options.every), while: (result) => isOpen(result.operation) }),
  );

  return options.deadline === undefined ? poll : poll.pipe(Effect.timeout(options.deadline));
}
