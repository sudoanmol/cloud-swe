/**
 * Path: server/src/sandbox/command-records.ts
 * Used by: server/src/sandbox/{command-lifecycle,commands}.ts, server/src/sessions/{keep-alive,projection}.ts, server/src/tools/registry.ts.
 * Purpose: The durable command record and its state machine: storage, cancel markers and the poll that ends every command.
 */

import { Buffer } from 'node:buffer';

import { type CommandRecord, OpenCommandRecord } from '@cloud-swe/protocol';
import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { CommandOperation, FileContent, type OpenCommandOperation, ShellProgress } from '@cloud-swe/protocol/tools';
import { FileError } from '@earendil-works/pi-durable/env';
import { type Duration, Effect, Schedule } from 'effect';

import { catalogStub } from '../env.ts';
import { type KvReader as Reader, readParsed } from '../storage.ts';
import type { ToolHost } from './host.ts';
import { readRemoteFile, writeRemoteFile } from './remote.ts';
import { commandPrefix } from './runner.ts';

export const unresolvedReason = 'Remote command outcome is unresolved; no automatic re-execution';

/** How long a command may show no progress before it is declared lost. */
type ProgressLimits = { missingMs: number; frozenMs: number };

const WATCHING: ProgressLimits = { missingMs: 15_000, frozenMs: 15_000 };

// A cancel marker is already written: the supervisor saves before checking it, so a missing file cannot start later.
export const STOPPING: ProgressLimits = { missingMs: 0, frozenMs: 5000 };

// Provider outages are retried until the caller's deadline; they never prove a command is gone.
const READ_BACKOFF = Schedule.min([Schedule.exponential('200 millis'), Schedule.spaced('5 seconds')]);

const OPEN_PREFIX = 'command-open:';

const commandKey = (taskId: number) => 'command:' + taskId;

const outputKey = (taskId: number) => 'command-output:' + taskId;

const OPEN_KINDS: ReadonlySet<string> = new Set(OpenCommandRecord.options.map((option) => option.shape.kind.value));

export function isOpen(operation: CommandOperation): operation is OpenCommandOperation {
  return OPEN_KINDS.has(operation.record.kind);
}

export async function readCommand(storage: Reader, taskId: number): Promise<CommandOperation | undefined> {
  return readParsed(storage, commandKey(taskId), CommandOperation);
}

async function requireCommand(storage: Reader, taskId: number): Promise<CommandOperation> {
  return CommandOperation.parse(await storage.get<unknown>(commandKey(taskId)));
}

async function store(storage: Pick<DurableObjectStorage, 'put' | 'delete'>, operation: CommandOperation) {
  const id = operation.nativeTaskId;
  await storage.put(commandKey(id), operation);

  if (isOpen(operation)) await storage.put(OPEN_PREFIX + id, id);
  else await storage.delete(OPEN_PREFIX + id);
}

export async function saveCommand(host: ToolHost, operation: CommandOperation) {
  await host.storage.transaction((tx) => store(tx, operation));
}

export async function commandOperations(host: ToolHost) {
  const index = await host.storage.list<unknown>({ prefix: OPEN_PREFIX });
  const keys = [...index.values()].map((id) => commandKey(CommandOperation.shape.nativeTaskId.parse(id)));

  if (keys.length === 0) return [];
  const saved = await host.storage.get<unknown>(keys);

  return [...saved.values()].flatMap((raw) => {
    const operation = CommandOperation.parse(raw);

    return isOpen(operation) ? [operation] : [];
  });
}

async function updateOpen(
  host: ToolHost,
  taskId: number,
  change: (current: OpenCommandOperation, tx: DurableObjectTransaction) => Promise<CommandOperation> | CommandOperation,
): Promise<CommandOperation> {
  return host.storage.transaction(async (tx) => {
    const current = await requireCommand(tx, taskId);

    if (!isOpen(current)) return current;
    const next = await change(current, tx);
    await store(tx, next);

    return next;
  });
}

export function markUncertain(host: ToolHost, operation: CommandOperation) {
  return updateOpen(host, operation.nativeTaskId, (current) => ({
    ...current,
    record: { ...current.record, kind: 'uncertain', reason: unresolvedReason },
  }));
}

export const deletedReason =
  'The sandbox was deleted while the command was running, which ended it; it may have partially run and was not retried';

const silentReason = 'Remote command stopped reporting; it may have partially run and was not retried';

/** The command's process is known to be gone, so it ends here instead of staying open and unresolved. */
export function markLost(host: ToolHost, operation: CommandOperation, reason: string) {
  return updateOpen(host, operation.nativeTaskId, (current) => {
    const { identity, output, outputBytes } = current.record;

    return { ...current, record: { kind: 'lost', identity, output, outputBytes, reason } };
  });
}

export async function markNotStarted(host: ToolHost, operation: CommandOperation) {
  await saveCommand(host, {
    ...operation,
    record: { kind: 'not_started', identity: operation.record.identity, reason: 'Cancelled before dispatch' },
  });
}

export function requestInterruption(host: ToolHost, operation: CommandOperation) {
  return updateOpen(host, operation.nativeTaskId, (current) => ({
    ...current,
    record: { ...current.record, cancelRequested: true },
  }));
}

async function completedProgress(host: ToolHost, operation: CommandOperation): Promise<ShellProgress> {
  if (operation.record.kind !== 'exited') throw new Error('Command is not terminal');

  const encoded = FileContent.parse({
    content: await host.storage.get<unknown>(outputKey(operation.nativeTaskId)),
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

async function sandboxDeleted(host: ToolHost, workspace: WorkspaceRecord): Promise<boolean> {
  const state = await catalogStub(host.env)
    .workspaceState(workspace.sessionId, workspace.id, true)
    .catch(() => 'unreachable' as const);

  return state === 'deleted';
}

type Verdict = { kind: 'waiting' } | { kind: 'silent' } | { kind: 'advanced'; progress: ShellProgress };

function judge(
  record: OpenCommandOperation['record'],
  progress: ShellProgress | null,
  limits: ProgressLimits,
  now: number,
): Verdict {
  if (progress?.kind === 'exited' || (progress !== null && progress.heartbeat > record.heartbeat))
    return { kind: 'advanced', progress };

  return now - record.lastSeenAt >= (progress === null ? limits.missingMs : limits.frozenMs)
    ? { kind: 'silent' }
    : { kind: 'waiting' };
}

function advance(current: OpenCommandOperation, progress: ShellProgress, now: number): CommandOperation {
  const { identity, cancelRequested } = current.record;
  const retained = { output: progress.output.slice(-8192), outputBytes: progress.outputBytes };

  return {
    ...current,
    record:
      progress.kind === 'exited'
        ? { ...retained, kind: 'exited', identity, exitCode: progress.exitCode, termination: progress.termination }
        : { ...retained, kind: 'running', identity, cancelRequested, heartbeat: progress.heartbeat, lastSeenAt: now },
  };
}

async function reconcileCommand(
  host: ToolHost,
  workspace: WorkspaceRecord,
  operation: CommandOperation,
  limits: ProgressLimits = WATCHING,
): Promise<{ operation: CommandOperation; progress: ShellProgress | null }> {
  if (operation.record.kind === 'exited') return { operation, progress: await completedProgress(host, operation) };

  if (!isOpen(operation)) return { operation, progress: null };
  let progress: ShellProgress | null;

  try {
    progress = await readProgress(host, workspace, operation.record.identity);
  } catch (error) {
    // Only a deleted sandbox ends its commands for good; a paused one keeps them. Anything else is an outage, retried by
    // the caller.
    const state = await catalogStub(host.env).workspaceState(workspace.sessionId, workspace.id, true);

    if (state !== 'deleted') throw error;

    return { operation: await markLost(host, operation, deletedReason), progress: null };
  }

  const verdict = judge(operation.record, progress, limits, Date.now());

  switch (verdict.kind) {
    case 'waiting':
      return { operation, progress };
    case 'silent':
      // A deleted sandbox answers a read like a missing file, so ask before calling the command silent.
      if (progress === null && (await sandboxDeleted(host, workspace)))
        return { operation: await markLost(host, operation, deletedReason), progress };

      // Before giving up, stop a supervisor that is merely slow or has not started yet.
      await writeCancelMarker(host, workspace, operation.record.identity);

      return { operation: await markLost(host, operation, silentReason), progress };
    case 'advanced':
      return {
        operation: await updateOpen(host, operation.nativeTaskId, async (current, tx) => {
          if (verdict.progress.kind === 'exited') {
            // Separate bounded blob: keep terminal output recoverable even if the sandbox loses /tmp.
            await tx.put(outputKey(current.nativeTaskId), Buffer.from(verdict.progress.output).toString('base64'));
          }

          return advance(current, verdict.progress, Date.now());
        }),
        progress,
      };
  }
}

/** Polls the command until it leaves its open states. Fails only when a deadline was given and passes first. */
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
