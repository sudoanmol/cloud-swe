import {
  Entry,
  EntryId,
  HistoryResponse,
  NestedCallSummary,
  PageQuery,
  Session,
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

import { apiError } from '../errors.ts';
import { NOTICE_KIND } from './notice.ts';

export function toolArguments(records: readonly EntryRecord[]) {
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

async function nestedResults(harness: PiHarness, callIds: ReadonlySet<string>) {
  const results = new Map<string, NativeNestedResult>();

  if (callIds.size === 0) return results;
  const pi = await harness.pi();
  const root = await pi.root(BG);
  const live = await pi.snapshot(LiveDoc, root.id, BG);

  // Use native typed parent IDs, never cast an unvalidated JSON number to a Pi TaskId.
  for (const slot of live?.nestedTools ?? []) {
    if (!callIds.has(slot.callId) || slot.status !== 'done') continue;
    const key = slot.callId.slice(slot.parentCallId.length + 1);
    const state = await pi.snapshot(NestedCallDoc, slot.parentTaskId, key, BG);

    if (state?.result) results.set(slot.callId, NativeNestedResult.parse(state.result));
  }

  return results;
}

async function liveTools(harness: PiHarness, view: ConversationView, commands: readonly OpenCommandOperation[]) {
  const parsed = NativeLive.safeParse(view.docs['pi.live']);
  const live = parsed.success ? parsed.data : NativeLive.parse({});
  const argumentsByCall = toolArguments(view.entries);

  const entries = view.entries.flatMap((record) => {
    const entry = toolResultEntry(record, argumentsByCall, commands);

    return entry?.kind === 'tool' ? [entry] : [];
  });

  const nested = await nestedResults(
    harness,
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
    const committed = slot.entry === undefined ? undefined : entries.find((entry) => entry.id === String(slot.entry));
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

function encodePosition(session: Session, native: Cursor) {
  return btoa(JSON.stringify(HistoryPosition.parse({ sessionId: session.id, native })));
}

export async function history(
  harness: PiHarness,
  session: Session,
  raw: PageQuery,
  commands: readonly OpenCommandOperation[],
) {
  const query = PageQuery.parse(raw);
  let native: HistoryPosition['native'] | undefined;

  if (query.cursor) {
    try {
      const position = HistoryPosition.parse(JSON.parse(atob(query.cursor)));

      if (position.sessionId !== session.id) return apiError('invalid_cursor');
      native = position.native;
    } catch {
      return apiError('invalid_cursor');
    }
  }

  const root = await (await harness.pi()).root(BG);
  const page = await root.entries({ order: 'descending' }, query.limit, native, BG);

  const records = [...page.items].reverse().map(visible);

  const projectAll = (args: ReturnType<typeof toolArguments>) =>
    records.map((record) => ({ ...project(session, record, args, commands), native: plain(record) }));

  let entries = projectAll(toolArguments(records));

  // A tool result's call is in the assistant message just before it, which may be on the next (older) page.
  // One extra page covers any realistic parallel-call fan-out; a call beyond it stays truthfully null.
  if (page.next && entries.some((entry) => entry.kind === 'tool' && entry.arguments === null)) {
    const older = await root.entries({ order: 'descending' }, 100, page.next, BG);

    entries = projectAll(toolArguments([...older.items, ...records]));
  }

  return HistoryResponse.parse({
    entries,
    nextCursor: page.next ? encodePosition(session, page.next) : null,
  });
}

export async function snapshotFromView(
  harness: PiHarness,
  session: Session,
  view: ConversationView,
  commands: readonly OpenCommandOperation[],
): Promise<Snapshot> {
  // Snapshot is the bounded active context; history includes older entries across compaction/reset boundaries.
  const records = view.entries.slice(-99).map(visible);
  const args = toolArguments(view.entries);
  const entries = records.map((record) => project(session, record, args, commands));
  const first = records[0];
  const live = view.docs['pi.live'];

  const partial = NativeLive.safeParse(live);

  if (partial.success && partial.data.generation?.message) {
    const message = partial.data.generation.message;

    if (message.content.length > 0)
      entries.push(
        Entry.parse({
          id: EntryId.parse('live'),
          createdAt: new Date(message.timestamp).toISOString(),
          kind: 'message',
          role: 'assistant',
          status: 'streaming',
          content: message.content,
        }),
      );
  }

  const tools = await liveTools(harness, view, commands);

  return Snapshot.parse({
    session,
    tools: tools.slice(0, 100),
    toolsTruncated: tools.length > 100,
    history: {
      entries,
      nextCursor: first ? encodePosition(session, { after: Number(first.id), order: 'descending' }) : null,
    },
  });
}
