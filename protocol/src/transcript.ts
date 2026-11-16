/**
 * Path: protocol/src/transcript.ts
 * Used by: protocol/src/index.ts.
 * Purpose: What a conversation's transcript projects to: content blocks, tool activity, entries, history pages and the live layer.
 */

import { z } from 'zod';

import { ImageMediaType } from './attachments.ts';
import { AttachmentId, Cursor, EntryId, OperationId, Timestamp, ToolCallId, ToolName } from './primitives.ts';

export const ContentBlock = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string() }),
  z.strictObject({ kind: z.literal('reasoning'), text: z.string() }),
  z.strictObject({
    kind: z.literal('tool_call'),
    toolCallId: ToolCallId,
    name: ToolName,
    arguments: z.record(z.string(), z.json()),
  }),
  // The bytes are fetched from GET /v1/sessions/:sessionId/attachments/:attachmentId.
  z.strictObject({ kind: z.literal('image'), attachmentId: AttachmentId, mediaType: ImageMediaType }),
]);

export type ContentBlock = z.infer<typeof ContentBlock>;

export const ToolOutcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unavailable'), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('running'), output: z.string().optional() }),
  z.strictObject({ kind: z.literal('succeeded'), output: z.string().nullable() }),
  z.strictObject({ kind: z.literal('failed'), message: z.string().min(1), output: z.string().optional() }),
  z.strictObject({ kind: z.literal('interrupted'), reason: z.string().min(1), output: z.string().optional() }),
  z.strictObject({
    kind: z.literal('uncertain'),
    operationId: OperationId,
    reason: z.string().min(1),
    output: z.string().optional(),
  }),
]);

export const NestedCallSummary = z.strictObject({
  localId: z.number().int().positive(),
  name: z.string().min(1),
  argumentsPreview: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});

export const ToolActivity = z.strictObject({
  toolCallId: ToolCallId,
  parentToolCallId: ToolCallId.nullable().default(null),
  taskId: z.string().min(1).nullable().default(null),
  name: ToolName,
  arguments: z.record(z.string(), z.json()).nullable(),
  outcome: ToolOutcome,
  structuredOutput: z.json().optional(),
  details: z.json().optional(),
  nestedCalls: z.array(NestedCallSummary).default([]),
});

export type ToolActivity = z.infer<typeof ToolActivity>;

const entryFields = { id: EntryId, createdAt: Timestamp, native: z.json().optional() };

// A committed transcript entry. Its ID is stable, but its projection is not: a tool entry's outcome can change (an
// uncertain remote command resolves), so a client replaces an entry it holds when the same ID arrives again.
export const Entry = z.discriminatedUnion('kind', [
  z.strictObject({ ...entryFields, kind: z.literal('native'), nativeKind: z.string().min(1), payload: z.json() }),
  z.strictObject({
    ...entryFields,
    kind: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    content: z.array(ContentBlock).min(1),
    status: z.enum(['committed', 'interrupted']),
  }),
  z.strictObject({
    ...entryFields,
    kind: z.literal('tool'),
    ...ToolActivity.shape,
  }),
]);

export type Entry = z.infer<typeof Entry>;

export const HISTORY_PAGE_LIMIT = 100;

// Live tool activity a snapshot carries; any beyond it are reported as truncated.
export const SNAPSHOT_TOOLS_LIMIT = 100;

// Entries oldest first. `nextCursor` pages backwards, to older entries.
export const HistoryResponse = z.strictObject({
  entries: z.array(Entry).max(HISTORY_PAGE_LIMIT),
  nextCursor: Cursor.nullable(),
});

/**
 * What is happening now and not yet committed: the assistant message Pi is streaming (null between messages) and the
 * running tools. It is provisional: each `live` value replaces the previous one whole, and once the message commits
 * it arrives as an entry and leaves `message`.
 */
export const LiveState = z.strictObject({
  message: z.strictObject({ createdAt: Timestamp, content: z.array(ContentBlock).min(1) }).nullable(),
  tools: z.array(ToolActivity).max(SNAPSHOT_TOOLS_LIMIT),
  toolsTruncated: z.boolean(),
});

export type LiveState = z.infer<typeof LiveState>;
