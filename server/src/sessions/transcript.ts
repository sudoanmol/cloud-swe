/**
 * Path: server/src/sessions/transcript.ts
 * Used by: server/src/sessions/{events,thread}.ts.
 * Purpose: Projects Pi transcript and live tool state into history pages, snapshots and stream events, without copying them into another store.
 */

import {
  Entry,
  EntryId,
  HISTORY_PAGE_LIMIT,
  SNAPSHOT_TOOLS_LIMIT,
  HistoryResponse,
  LiveState,
  NestedCallSummary,
  type PageQuery,
  type Session,
  Snapshot,
  ToolActivity,
} from '@cloud-swe/protocol';
import {
  NativeCodemodeDetails,
  NativeContent,
  NativeLive,
  NativeNestedResult,
  NativeNestedText,
  NativeToolData,
  NativeToolResult,
} from '@cloud-swe/protocol/native';
import { HistoryPosition } from '@cloud-swe/protocol/storage';
import type { OpenCommandOperation } from '@cloud-swe/protocol/tools';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  type ConversationView,
  type Cursor,
  type EntryRecord,
  LiveDoc,
  NestedCallDoc,
} from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { failure, type Result, success } from '../errors.ts';
import { NOTICE_KIND } from './notice.ts';
import { requireConversation } from './pi.ts';

function toolArguments(records: readonly EntryRecord[]) {
  const argumentsByCall = new Map<string, Array<{ entryId: number; arguments: ToolActivity['arguments'] }>>();

  for (const record of records) {
    for (const message of record.model ?? []) {
      if (message.role !== 'assistant') continue;

      for (const block of NativeContent.parse(message.content)) {
        if (block.kind === 'tool_call') {
          const previous = argumentsByCall.get(block.toolCallId) ?? [];
          previous.push({ entryId: Number(record.id), arguments: block.arguments });
          argumentsByCall.set(block.toolCallId, previous);
        }
      }
    }
  }

  for (const entries of argumentsByCall.values()) entries.sort((a, b) => a.entryId - b.entryId);

  return argumentsByCall;
}

function remoteOutcome(command: OpenCommandOperation | undefined): ToolActivity['outcome'] | undefined {
  if (!command || (command.record.kind !== 'uncertain' && !command.record.cancelRequested)) return undefined;

  return {
    kind: 'uncertain',
    operationId: command.record.identity.operationId,
    reason:
      command.record.kind === 'uncertain' ? command.record.reason : 'Remote command interruption is not confirmed',
    output: command.record.output,
  };
}

function resultOutcome(
  isError: boolean,
  output: string | null,
  diagnostics: NativeNestedResult['diagnostics'],
): ToolActivity['outcome'] {
  const failure = diagnostics.find((diagnostic) => diagnostic.severity === 'error');

  if (failure?.code && ['aborted', 'interrupted', 'abandoned'].includes(failure.code)) {
    return { kind: 'interrupted', reason: failure.message, output: output ?? undefined };
  }

  if (isError) return { kind: 'failed', message: failure?.message || 'Tool failed', output: output ?? undefined };

  return { kind: 'succeeded', output };
}

function nestedSummary(name: string, details: ToolActivity['details']) {
  if (name !== 'codemode') return [];
  const parsed = NativeCodemodeDetails.safeParse(details);

  if (!parsed.success) return [];
  const statuses = { running: 'running', ok: 'succeeded', error: 'failed', cancelled: 'interrupted' };

  return parsed.data.calls.map((call) =>
    NestedCallSummary.parse({
      localId: call.id,
      name: call.name,
      argumentsPreview: call.args,
      status: statuses[call.status],
      durationMs: call.durationMs,
      error: call.error,
    }),
  );
}

function toolResultEntry(
  record: EntryRecord,
  argumentsByCall: ReturnType<typeof toolArguments>,
  commands: readonly OpenCommandOperation[],
): Entry | undefined {
  const parsed = NativeToolResult.safeParse(record.model?.length === 1 ? record.model[0] : undefined);

  if (!parsed.success) return undefined;
  const message = parsed.data;

  const output = message.content
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('\n');

  const diagnostics = NativeToolData.safeParse(record.data);
  const command = commands.find((operation) => operation.nativeTaskId === record.byTaskId);

  return Entry.parse({
    id: String(record.id),
    createdAt: new Date(message.timestamp).toISOString(),
    kind: 'tool',
    toolCallId: message.toolCallId,
    name: message.toolName,
    taskId: record.byTaskId === undefined ? null : String(record.byTaskId),
    arguments:
      argumentsByCall.get(message.toolCallId)?.findLast((call) => call.entryId < Number(record.id))?.arguments ?? null,
    outcome:
      remoteOutcome(command) ??
      resultOutcome(message.isError, output, diagnostics.success ? diagnostics.data.diagnostics : []),
    details: message.details,
    structuredOutput: message.structuredOutput,
    nestedCalls: nestedSummary(message.toolName, message.details),
  });
}

async function nestedResults(harness: PiHarness, conversationId: string, callIds: ReadonlySet<string>) {
  const results = new Map<string, NativeNestedResult>();

  if (callIds.size === 0) return results;
  const pi = await harness.pi();
  const conversation = await requireConversation(harness, conversationId);
  const live = await pi.snapshot(LiveDoc, conversation.id, BG);

  // Use native typed parent IDs, never cast an unvalidated JSON number to a Pi TaskId.
  for (const slot of live?.nestedTools ?? []) {
    if (!callIds.has(slot.callId) || slot.status !== 'done') continue;
    const key = slot.callId.slice(slot.parentCallId.length + 1);
    const state = await pi.snapshot(NestedCallDoc, slot.parentTaskId, key, BG);

    if (state?.result) results.set(slot.callId, NativeNestedResult.parse(state.result));
  }

  return results;
}

// oxlint-disable-next-line eslint/complexity -- one pass over every tool state; split with the V1 tool projection work.
async function liveTools(
  harness: PiHarness,
  conversationId: string,
  view: ConversationView,
  argumentsByCall: ReturnType<typeof toolArguments>,
  commands: readonly OpenCommandOperation[],
) {
  const parsed = NativeLive.safeParse(view.docs['pi.live']);
  const live = parsed.success ? parsed.data : NativeLive.parse({});

  const committedEntry = (id: number | undefined) => {
    const record = id === undefined ? undefined : view.entries.find((entry) => Number(entry.id) === id);

    const entry = record && toolResultEntry(record, argumentsByCall, commands);

    return entry?.kind === 'tool' ? entry : undefined;
  };

  const nested = await nestedResults(
    harness,
    conversationId,
    new Set((live.nestedTools ?? []).filter((slot) => slot.status === 'done').map((slot) => slot.callId)),
  );

  const activities: ToolActivity[] = [];

  const slots = [
    ...(live.tools ?? []).map((slot) => ({
      ...slot,
      parentCallId: null,
      arguments: argumentsByCall.get(slot.callId)?.at(-1)?.arguments ?? null,
      summary: undefined,
    })),
    ...(live.nestedTools ?? []),
  ];

  for (const slot of slots) {
    const committed = committedEntry(slot.entry);
    const result = nested.get(slot.callId);
    let outcome: ToolActivity['outcome'];
    const command = commands.find((operation) => operation.nativeTaskId === slot.taskId);
    const unresolved = remoteOutcome(command);

    if (unresolved) outcome = unresolved;
    else if (committed) outcome = committed.outcome;
    else if (slot.status !== 'done')
      outcome = slot.status === 'pending' ? { kind: 'pending' } : { kind: 'running', output: slot.output };
    else if (result) {
      const text = NativeNestedText.safeParse(result.structuredOutput);
      outcome = resultOutcome(result.isError, text.success ? text.data : null, result.diagnostics);
    } else if (slot.summary?.isError)
      outcome = { kind: 'failed', message: slot.summary.error || 'Nested tool failed', output: slot.output };
    else if (slot.summary?.isError === false) outcome = { kind: 'succeeded', output: slot.output ?? null };
    else outcome = { kind: 'unavailable', reason: 'Native tool ended without a readable result' };
    activities.push(
      ToolActivity.parse({
        toolCallId: slot.callId,
        parentToolCallId: slot.parentCallId,
        taskId: slot.taskId === undefined ? null : String(slot.taskId),
        name: slot.name,
        arguments: slot.arguments,
        outcome,
        details: result?.details ?? committed?.details ?? slot.details,
        structuredOutput: result?.structuredOutput ?? committed?.structuredOutput,
        nestedCalls: committed?.nestedCalls ?? [],
      }),
    );
  }

  for (const block of live.generation?.message?.content ?? []) {
    if (block.kind !== 'tool_call' || activities.some((activity) => activity.toolCallId === block.toolCallId)) continue;
    activities.push(
      ToolActivity.parse({
        toolCallId: block.toolCallId,
        name: block.name,
        arguments: block.arguments,
        outcome: { kind: 'pending' },
      }),
    );
  }

  for (const command of commands) {
    if (activities.some((activity) => activity.taskId === String(command.nativeTaskId))) continue;
    activities.push(
      ToolActivity.parse({
        toolCallId: command.toolCallId,
        parentToolCallId: command.parentToolCallId,
        taskId: String(command.nativeTaskId),
        name: 'bash',
        arguments: null,
        outcome: remoteOutcome(command) ?? {
          kind: 'uncertain',
          operationId: command.record.identity.operationId,
          reason: 'Remote work outlived its native invocation',
          output: command.record.output,
        },
      }),
    );
  }

  return activities;
}

// The notice is for the model. Clients see that something happened, never the notice text as a user message.
const visible = (record: EntryRecord): EntryRecord =>
  record.kind === NOTICE_KIND ? { ...record, model: undefined } : record;

const plain = (record: EntryRecord): NonNullable<Entry['native']> => JSON.parse(JSON.stringify(record));

// Entries carry no raw `native` record; paginated history adds it, snapshots and SSE frames stay small.
function project(
  session: Session,
  record: EntryRecord,
  args: ReturnType<typeof toolArguments>,
  commands: readonly OpenCommandOperation[],
): Entry {
  const tool = toolResultEntry(record, args, commands);

  if (tool) return tool;
  const id = EntryId.parse(String(record.id));
  const message = record.model?.length === 1 ? record.model[0] : undefined;
  const createdAt = message ? new Date(message.timestamp).toISOString() : session.createdAt;
  const content = message ? NativeContent.parse(message.content) : [];

  if (message && (message.role === 'user' || message.role === 'assistant') && content.length > 0) {
    return Entry.parse({
      id,
      createdAt,
      kind: 'message',
      role: message.role,
      content,
      status: message.role === 'assistant' && message.stopReason === 'aborted' ? 'interrupted' : 'committed',
    });
  }

  return Entry.parse({ id, createdAt, kind: 'native', nativeKind: record.kind, payload: plain(record) });
}

function encodePosition(session: Session, conversationId: string, native: Cursor) {
  return btoa(JSON.stringify(HistoryPosition.parse({ sessionId: session.id, conversationId, native })));
}

/** Where a cursor resumes, if it was made for this conversation of this session. */
function decodePosition(session: Session, conversationId: string, cursor: string) {
  try {
    const position = HistoryPosition.parse(JSON.parse(atob(cursor)));

    return position.sessionId === session.id && position.conversationId === conversationId
      ? position.native
      : undefined;
  } catch {
    return undefined;
  }
}

/** A page of the conversation's committed entries, newest page first, each page in transcript order. */
export async function history(
  harness: PiHarness,
  session: Session,
  conversationId: string,
  query: PageQuery,
  commands: readonly OpenCommandOperation[],
): Promise<Result<Snapshot['history']>> {
  const native = query.cursor === undefined ? undefined : decodePosition(session, conversationId, query.cursor);

  if (query.cursor !== undefined && native === undefined) return failure('invalid_cursor');

  const conversation = await requireConversation(harness, conversationId);
  const page = await conversation.entries({ order: 'descending' }, query.limit, native, BG);

  const records = [...page.items].reverse().map(visible);

  const projectAll = (args: ReturnType<typeof toolArguments>) =>
    records.map((record) => ({ ...project(session, record, args, commands), native: plain(record) }));

  let entries = projectAll(toolArguments(records));

  // A tool result's call is in the assistant message just before it, which may be on the next (older) page.
  // One extra page covers any realistic parallel-call fan-out; a call beyond it stays truthfully null.
  if (page.next && entries.some((entry) => entry.kind === 'tool' && entry.arguments === null)) {
    const older = await conversation.entries({ order: 'descending' }, HISTORY_PAGE_LIMIT, page.next, BG);

    entries = projectAll(toolArguments([...older.items, ...records]));
  }

  return success(
    HistoryResponse.parse({
      entries,
      nextCursor: page.next ? encodePosition(session, conversationId, page.next) : null,
    }),
  );
}

/** What a conversation's snapshot and stream events are made from, read once per frame from Pi's view of it. */
export type ConversationState = {
  /** Pi's active context: a head marker (compaction or reset) if there is one, then later entries in ID order. */
  records: readonly EntryRecord[];
  /** Describes the active conversation, whichever this is. */
  session: Session;
  live: LiveState;
  /** Each tool task's unresolved remote outcome, as JSON: it overrides the task's committed result until it resolves. */
  remote: ReadonlyMap<number, string>;
  project: (records: readonly EntryRecord[]) => Entry[];
  snapshot: () => Snapshot;
};

export async function conversationState(
  harness: PiHarness,
  session: Session,
  conversationId: string,
  view: ConversationView,
  commands: readonly OpenCommandOperation[],
): Promise<ConversationState> {
  const args = toolArguments(view.entries);

  const projectAll = (records: readonly EntryRecord[]) =>
    records.map((record) => project(session, visible(record), args, commands));

  const partial = NativeLive.safeParse(view.docs['pi.live']);
  const message = partial.success ? partial.data.generation?.message : undefined;

  const tools = await liveTools(harness, conversationId, view, args, commands);

  const live = LiveState.parse({
    message:
      message && message.content.length > 0
        ? { createdAt: new Date(message.timestamp).toISOString(), content: message.content }
        : null,
    tools: tools.slice(0, SNAPSHOT_TOOLS_LIMIT),
    toolsTruncated: tools.length > SNAPSHOT_TOOLS_LIMIT,
  });

  const remote = new Map(
    commands.flatMap((command) => {
      const outcome = remoteOutcome(command);

      return outcome ? [[command.nativeTaskId, JSON.stringify(outcome)] as const] : [];
    }),
  );

  // Snapshot is the bounded active context; history includes older entries across compaction/reset boundaries.
  const snapshot = () => {
    const tail = view.entries.slice(-HISTORY_PAGE_LIMIT);
    const first = tail[0];

    return Snapshot.parse({
      conversationId,
      session,
      history: {
        entries: projectAll(tail),
        nextCursor: first
          ? encodePosition(session, conversationId, { after: Number(first.id), order: 'descending' })
          : null,
      },
      live,
    });
  };

  return { records: view.entries, session, live, remote, project: projectAll, snapshot };
}
