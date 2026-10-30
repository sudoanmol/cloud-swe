import { Entry, NestedCallSummary, ToolActivity } from '@cloud-swe/protocol';
import {
  NativeCodemodeDetails,
  NativeContent,
  NativeLive,
  NativeNestedResult,
  NativeNestedText,
  NativeToolData,
  NativeToolResult,
} from '@cloud-swe/protocol/native';
import type { OpenCommandOperation } from '@cloud-swe/protocol/tools';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc, NestedCallDoc, type ConversationView, type EntryRecord } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

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

export function toolResultEntry(
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
    runId: command?.runId ?? null,
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
    native: JSON.parse(JSON.stringify(record)),
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

export async function liveTools(harness: PiHarness, view: ConversationView, commands: readonly OpenCommandOperation[]) {
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
