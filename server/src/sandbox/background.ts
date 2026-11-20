/**
 * Path: server/src/sandbox/background.ts
 * Used by: server/src/sandbox/command-lifecycle.ts, server/src/sessions/{background,keep-alive,projection,workspace-ready}.ts, server/src/tools/background.ts.
 * Purpose: Background commands: the agent's commands that outlive their tool call. Their record, start, refresh from the sandbox, stop and end, with no job of their own: whoever looks refreshes them.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { BACKGROUND_LIMITS, BackgroundCommand } from '@cloud-swe/protocol/background';
import { StoredBackgroundCommand, type WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { ShellInput, ShellProgress } from '@cloud-swe/protocol/tools';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';

import { catalogStub } from '../env.ts';
import { deterministicUuid } from '../ids.ts';
import { type KvLister, type KvReader, listParsed, readParsed } from '../storage.ts';
import { requireSession } from '../thread-store.ts';
import {
  advance,
  isOpenRecord,
  judge,
  type OpenRecord,
  type ProgressLimits,
  readProgress,
  silentReason,
  STOPPING,
  WATCHING,
  writeCancelMarker,
} from './command-records.ts';
import { syncSandbox } from './egress.ts';
import type { ToolHost } from './host.ts';
import { dispatchRemoteCommand } from './remote.ts';
import { supervisorCommand } from './runner.ts';

type Row = StoredBackgroundCommand;

type OpenRow = Row & { record: OpenRecord };

const PREFIX = 'background:';

const key = (id: string) => PREFIX + id;

const deletedSandboxReason = 'The sandbox was deleted, which ended this command; it was not restarted';

const unconfirmedReason = "Its start couldn't be confirmed, so it may not have run; it was not retried";

const notStartedReason = 'Cancelled before it started';

const isOpenRow = (row: Row): row is OpenRow => isOpenRecord(row.record);

const iso = (ms: number) => new Date(ms).toISOString();

export const readBackground = (storage: KvReader, id: string) => readParsed(storage, key(id), StoredBackgroundCommand);

/** Every background command the session keeps, newest start first. */
export async function listBackground(storage: KvLister): Promise<Row[]> {
  const rows = await listParsed(storage, PREFIX, StoredBackgroundCommand);

  return rows.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
}

const preview = (command: string) =>
  command.length <= BACKGROUND_LIMITS.commandPreview
    ? command
    : `${command.slice(0, BACKGROUND_LIMITS.commandPreview - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;

/** The public shape of a stored command; a stored-only field never reaches a client. */
export function backgroundCommandView(row: Row): BackgroundCommand {
  const { id, cwd, conversationId, startedAt, checkedAt, record } = row;
  const common = { id, command: preview(row.command), cwd, conversationId, startedAt, checkedAt };
  const endedAt = row.endedAt ?? checkedAt ?? startedAt;

  switch (record.kind) {
    case 'prepared':
      return BackgroundCommand.parse({ ...common, state: 'starting' });
    case 'running':
    case 'uncertain':
      return BackgroundCommand.parse({ ...common, state: 'running', stopping: record.cancelRequested });
    case 'exited': {
      const stopped = record.termination === 'cancelled';

      return BackgroundCommand.parse({
        ...common,
        state: 'exited',
        exitCode: record.exitCode,
        termination: stopped ? 'stopped' : record.termination,
        stoppedBy: stopped ? row.stoppedBy : null,
        endedAt,
      });
    }

    case 'lost':
    case 'not_started':
      return BackgroundCommand.parse({ ...common, state: 'lost', reason: record.reason, endedAt });
  }
}

export const listOpenBackground = async (storage: KvLister): Promise<OpenRow[]> =>
  (await listBackground(storage)).filter(isOpenRow);

export async function backgroundProjection(storage: KvLister): Promise<BackgroundCommand[]> {
  return (await listBackground(storage)).map(backgroundCommandView);
}

/** Keeps the newest ended commands, so the list `Session` carries stays bounded. */
async function prune(tx: DurableObjectTransaction) {
  const ended = (await listBackground(tx)).filter((row) => !isOpenRow(row));
  const byEnd = ended.toSorted((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));

  for (const row of byEnd.slice(BACKGROUND_LIMITS.ended)) await tx.delete(key(row.id));
}

/** Changes an open command atomically. An ended or missing one is returned as it is: an end is final. */
async function update(host: ToolHost, id: string, change: (current: OpenRow) => Row): Promise<Row | undefined> {
  return host.storage.transaction(async (tx) => {
    const current = await readBackground(tx, id);

    if (!current || !isOpenRow(current)) return current;
    const next = StoredBackgroundCommand.parse(change(current));
    await tx.put(key(id), next);

    if (!isOpenRow(next)) await prune(tx);

    return next;
  });
}

const lost = (current: OpenRow, reason: string, now: number): Row => {
  const { identity, output, outputBytes } = current.record;

  return { ...current, record: { kind: 'lost', identity, output, outputBytes, reason }, endedAt: iso(now) };
};

export type StartResult =
  | { kind: 'started' | 'replayed'; row: Row }
  | { kind: 'limit' | 'blocked' }
  | { kind: 'not_started'; row: Row };

/**
 * Starts `input` once for this tool call. The ID comes from the call, so a replay finds the saved record and never
 * dispatches again; a start whose receipt was lost is resolved by a later refresh, never by running it twice.
 * `blocked` is asked only for a fresh start: an unresolved tool call's command refuses new commands.
 */
export async function startBackground(
  host: ToolHost,
  workspace: WorkspaceRecord,
  api: ToolExecutionApi,
  input: ShellInput,
  { signal, blocked }: { signal: AbortSignal | undefined; blocked: () => Promise<boolean> },
): Promise<StartResult> {
  const session = await requireSession(host.storage);
  const id = await deterministicUuid(`background:${session.id}:${api.conversationId}:${api.callId}`);
  const existing = await readBackground(host.storage, id);

  if (existing) return { kind: 'replayed', row: existing };

  if (await blocked()) return { kind: 'blocked' };

  // Synced before the record exists, so a slow sync never counts as the command's silence.
  const envPath = await syncSandbox(host, workspace, api);
  const now = Date.now();

  const row = StoredBackgroundCommand.parse({
    id,
    command: input.command,
    cwd: input.cwd,
    conversationId: String(api.conversationId),
    startedAt: iso(now),
    record: {
      kind: 'prepared',
      identity: { workspaceId: workspace.id, operationId: id },
      cancelRequested: false,
      heartbeat: 0,
      lastSeenAt: now,
      output: '',
      outputBytes: 0,
    },
    stoppedBy: null,
    checkedAt: null,
    endedAt: null,
  });

  // Counted and saved in one transaction, so parallel starts can't pass the limit together.
  const saved = await host.storage.transaction(async (tx) => {
    const running = await listOpenBackground(tx);

    if (running.length >= BACKGROUND_LIMITS.running) return false;
    await tx.put(key(id), row);

    return true;
  });

  if (!saved) return { kind: 'limit' };

  if (signal?.aborted) {
    const ended = await update(host, id, (current) => ({
      ...current,
      record: { kind: 'not_started', identity: current.record.identity, reason: notStartedReason },
      endedAt: iso(Date.now()),
    }));

    return { kind: 'not_started', row: ended ?? row };
  }

  try {
    await dispatchRemoteCommand(
      host.env,
      workspace,
      supervisorCommand(row.record.identity, input, envPath),
      AbortSignal.timeout(5000),
    );
  } catch {
    // A failed receipt does not mean dispatch failed. A refresh inspects this ID; the command is never sent again.
  }

  const started = await settle(host, workspace, id, WATCHING, 5000, (current) => current.record.kind !== 'prepared');

  return { kind: 'started', row: started ?? row };
}

type Refreshed = { row: Row | undefined; progress: ShellProgress | null; changed: boolean };

/**
 * Reads one command's progress from the sandbox and moves its record on, with the same limits as a tool call's
 * command. A failed read leaves the record alone and throws, unless the sandbox is gone, which ends it.
 */
async function refreshBackground(
  host: ToolHost,
  workspace: WorkspaceRecord,
  id: string,
  limits: ProgressLimits = WATCHING,
): Promise<Refreshed> {
  const row = await readBackground(host.storage, id);

  if (!row || !isOpenRow(row)) return { row, progress: null, changed: false };
  let progress: ShellProgress | null;

  try {
    progress = await readProgress(host, workspace, row.record.identity);
  } catch (error) {
    const state = await catalogStub(host.env).workspaceState(workspace.sessionId, workspace.id, true);

    if (state !== 'deleted') throw error;
    const ended = await update(host, id, (current) => lost(current, deletedSandboxReason, Date.now()));

    return { row: ended, progress: null, changed: true };
  }

  const now = Date.now();
  const judged = judge(row.record, progress, limits, now);
  const lastLook = Date.parse(row.checkedAt ?? row.startedAt);

  // Silence counts only while someone watches. After a gap, such as a sleep that froze the supervisor, the clock
  // restarts: a dead supervisor then shows running until a look 15 seconds later.
  const verdict =
    judged.kind === 'silent' && now - lastLook > WATCHING.frozenMs ? { kind: 'restart' as const } : judged;

  // Before giving up, stop a supervisor that is merely slow or has not started yet.
  if (verdict.kind === 'silent') await writeCancelMarker(host, workspace, row.record.identity);

  const next = await update(host, id, (current) => {
    const checked = { ...current, checkedAt: iso(now) };

    switch (verdict.kind) {
      case 'waiting':
        return checked;
      case 'restart':
        return { ...checked, record: { ...current.record, lastSeenAt: now } };
      case 'silent':
        return lost(checked, current.record.kind === 'prepared' ? unconfirmedReason : silentReason, now);
      case 'advanced': {
        const record = advance(current.record, verdict.progress, now);

        return { ...checked, record, endedAt: isOpenRecord(record) ? null : iso(now) };
      }
    }
  });

  return { row: next, progress, changed: next?.record.kind !== row.record.kind };
}

/** Refreshes until `done`, the command ends, or `ms` pass. A failed read is retried until then. */
async function settle(
  host: ToolHost,
  workspace: WorkspaceRecord,
  id: string,
  limits: ProgressLimits,
  ms: number,
  done: (row: Row) => boolean = () => false,
): Promise<Row | undefined> {
  const deadline = Date.now() + ms;

  for (;;) {
    const row = await refreshBackground(host, workspace, id, limits).then(
      (refreshed) => refreshed.row,
      () => readBackground(host.storage, id),
    );

    if (!row || !isOpenRow(row) || done(row) || Date.now() >= deadline) return row;
    await sleep(100);
  }
}

export type Output = { row: Row; live: boolean; window: string; outputBytes: number };

/**
 * A command's newest output. With `workspace`, a sandbox known to be running, it is read live: the supervisor's last
 * 64 KB, refreshing the record on the way. Otherwise, or when that read fails, it is the last 8 KB the record saved.
 */
export async function backgroundOutput(
  host: ToolHost,
  workspace: WorkspaceRecord | undefined,
  id: string,
): Promise<Output | undefined> {
  const row = await readBackground(host.storage, id);

  if (!row) return undefined;

  if (workspace) {
    const live = await (
      isOpenRow(row)
        ? refreshBackground(host, workspace, id)
        : readProgress(host, workspace, row.record.identity).then((progress) => ({ row, progress }))
    ).catch(() => undefined);

    if (live?.row && live.progress)
      return { row: live.row, live: true, window: live.progress.output, outputBytes: live.progress.outputBytes };
  }

  const current = (await readBackground(host.storage, id)) ?? row;
  const saved = 'output' in current.record ? current.record : { output: '', outputBytes: 0 };

  return { row: current, live: false, window: saved.output, outputBytes: saved.outputBytes };
}

/** Refreshes every open command, as a keep-alive tick does. Returns whether any changed state. */
export async function refreshOpenBackground(host: ToolHost, workspace: WorkspaceRecord): Promise<boolean> {
  const open = await listOpenBackground(host.storage);

  const changed = await Promise.all(
    open.map((row) =>
      refreshBackground(host, workspace, row.id).then(
        (refreshed) => refreshed.changed,
        () => false,
      ),
    ),
  );

  return changed.includes(true);
}

/**
 * Stops a command: marks the stop, writes its cancel marker, and waits up to 8 seconds for the supervisor to confirm.
 * The supervisor signals the whole process group. An unconfirmed stop stays `running` with the marker in place, and a
 * later refresh finishes it.
 */
export async function stopBackground(
  host: ToolHost,
  workspace: WorkspaceRecord,
  id: string,
  by: 'agent' | 'user',
): Promise<Row | undefined> {
  const marked = await update(host, id, (current) => ({
    ...current,
    stoppedBy: by,
    record: { ...current.record, cancelRequested: true },
  }));

  if (!marked || !isOpenRow(marked)) return marked;
  await writeCancelMarker(host, workspace, marked.record.identity);

  return settle(host, workspace, id, STOPPING, 8000);
}

/** The sandbox was deleted or replaced, so every open command's process is gone. They end now, truthfully. */
export async function endBackgroundOfDeletedSandbox(host: ToolHost): Promise<boolean> {
  const open = await listOpenBackground(host.storage);
  const now = Date.now();

  await Promise.all(open.map((row) => update(host, row.id, (current) => lost(current, deletedSandboxReason, now))));

  return open.length > 0;
}

/**
 * The part of a command's output from byte `offset`, at most `limit` bytes, out of `window`: the newest output, which
 * ends at byte `outputBytes`. It starts on a character boundary; what was asked for before the window is skipped.
 */
export function outputSlice(window: string, outputBytes: number, offset: number, limit = Number.POSITIVE_INFINITY) {
  const bytes = new TextEncoder().encode(window);
  const windowStart = Math.max(0, outputBytes - bytes.length);
  let index = Math.min(Math.max(offset, windowStart), outputBytes) - windowStart;

  while (index < bytes.length && ((bytes[index] ?? 0) & 0xc0) === 0x80) index++;
  let end = Math.min(bytes.length, index + limit);

  while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;

  return {
    offset: windowStart + index,
    end: windowStart + end,
    outputBytes,
    skippedBytes: Math.max(0, windowStart - offset),
    text: new TextDecoder().decode(bytes.subarray(index, end)),
  };
}
