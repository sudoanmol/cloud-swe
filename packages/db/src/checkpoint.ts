/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-unknown-parameters -- The decoder is a declarative schema table; blank lines would separate coupled variants without improving readability, and its exported functions are the JSON boundary. */

import { z } from "zod";

import { jsonValueSchema } from "./json";
import { publicFailureMessage } from "./public-failure";

/** The project-owned checkpoint envelope. Version 1 accepts the Pi SDK v3 file format. */
export const piCheckpointVersion = 1 as const;

const textContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.string().optional(),
});
const imageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
const thinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});
const toolCallSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), jsonValueSchema),
  thoughtSignature: z.string().optional(),
  namespace: z.string().optional(),
});
const usageSchema = z.object({
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(),
  cacheWrite: z.number().finite().nonnegative(),
  cacheWrite1h: z.number().finite().nonnegative().optional(),
  reasoning: z.number().finite().nonnegative().optional(),
  totalTokens: z.number().finite().nonnegative(),
  cost: z.object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative(),
    cacheWrite: z.number().finite().nonnegative(),
    total: z.number().finite().nonnegative(),
  }),
});

const contentSchema = z.union([
  z.string(),
  z.array(z.union([textContentSchema, imageContentSchema])),
]);

const diagnosticSchema = z.object({
  type: z.string(),
  timestamp: z.number().finite(),
  error: z
    .object({
      name: z.string().optional(),
      message: z.string(),
      code: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

const deferredHandleSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  api: z.string(),
  id: z.string(),
  expiresAt: z.number().finite().optional(),
  pollAfterMs: z.number().finite().optional(),
  data: jsonValueSchema.optional(),
});

const userMessageSchema = z.object({
  role: z.literal("user"),
  content: contentSchema,
  timestamp: z.number().finite(),
});
const assistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(z.union([textContentSchema, thinkingContentSchema, toolCallSchema])),
  api: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  usage: usageSchema,
  stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
  responseModel: z.string().optional(),
  responseId: z.string().optional(),
  providerThinkingLevel: z.string().optional(),
  diagnostics: z.array(diagnosticSchema).optional(),
  deferred: deferredHandleSchema.optional(),
  errorMessage: z.string().optional(),
  rawStopReason: z.string().optional(),
  endTurn: z.boolean().optional(),
  timestamp: z.number().finite(),
});
const toolResultMessageSchema = z.object({
  role: z.literal("toolResult"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  content: z.array(z.union([textContentSchema, imageContentSchema])),
  details: jsonValueSchema.optional(),
  usage: usageSchema.optional(),
  addedToolNames: z.array(z.string()).optional(),
  isError: z.boolean(),
  timestamp: z.number().finite(),
});
const customMessageSchema = z.object({
  role: z.literal("custom"),
  customType: z.string().min(1),
  content: contentSchema,
  display: z.boolean(),
  timestamp: z.number().finite(),
});
const bashExecutionMessageSchema = z
  .object({
    role: z.literal("bashExecution"),
    command: z.string(),
    output: z.string(),
    exitCode: z.number().int().optional(),
    cancelled: z.boolean(),
    truncated: z.boolean(),
    fullOutputPath: z.string().optional(),
    excludeFromContext: z.boolean().optional(),
    timestamp: z.number().finite(),
  })
  .transform((message) => ({ ...message, exitCode: message.exitCode }));
const branchSummaryMessageSchema = z.object({
  role: z.literal("branchSummary"),
  summary: z.string(),
  fromId: z.string().nullable(),
  timestamp: z.number().finite(),
});
const compactionSummaryMessageSchema = z.object({
  role: z.literal("compactionSummary"),
  summary: z.string(),
  tokensBefore: z.number().finite(),
  timestamp: z.number().finite(),
});

export const piAgentMessageSchema = z.union([
  userMessageSchema,
  assistantMessageSchema,
  toolResultMessageSchema,
  customMessageSchema,
  bashExecutionMessageSchema,
  branchSummaryMessageSchema,
  compactionSummaryMessageSchema,
]);

export type PiAgentMessage = z.infer<typeof piAgentMessageSchema>;

const sessionHeaderSchema = z.object({
  type: z.literal("session"),
  // The installed SDK migrates v1/v2 files in memory before exposing them to
  // callers. Persisted checkpoints therefore accept only the post-migration
  // v3 header; accepting older headers here would claim compatibility without
  // implementing the SDK's ID/parent migration rules.
  version: z.literal(3),
  id: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  cwd: z.string(),
  parentSession: z.string().optional(),
});

const entryBaseSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  timestamp: z.string().datetime({ offset: true }),
});

const sessionEntrySchema = z.discriminatedUnion("type", [
  entryBaseSchema.extend({ type: z.literal("message"), message: piAgentMessageSchema }),
  entryBaseSchema.extend({ type: z.literal("thinking_level_change"), thinkingLevel: z.string() }),
  entryBaseSchema.extend({
    type: z.literal("model_change"),
    provider: z.string().min(1),
    modelId: z.string().min(1),
  }),
  entryBaseSchema.extend({
    type: z.literal("compaction"),
    summary: z.string(),
    firstKeptEntryId: z.string().min(1),
    tokensBefore: z.number().finite(),
    details: jsonValueSchema.optional(),
    usage: usageSchema.optional(),
    fromHook: z.boolean().optional(),
  }),
  entryBaseSchema.extend({
    type: z.literal("branch_summary"),
    fromId: z.string().min(1),
    summary: z.string(),
    details: jsonValueSchema.optional(),
    usage: usageSchema.optional(),
    fromHook: z.boolean().optional(),
  }),
  entryBaseSchema.extend({
    type: z.literal("custom"),
    customType: z.string().min(1),
    data: jsonValueSchema.optional(),
  }),
  entryBaseSchema.extend({
    type: z.literal("custom_message"),
    customType: z.string().min(1),
    content: contentSchema,
    display: z.boolean(),
    details: jsonValueSchema.optional(),
  }),
  entryBaseSchema
    .extend({
      type: z.literal("label"),
      targetId: z.string().min(1),
      label: z.string().optional(),
    })
    .transform((entry) => ({ ...entry, label: entry.label })),
  entryBaseSchema.extend({ type: z.literal("session_info"), name: z.string().optional() }),
]);

export const piFileEntrySchema = z.union([sessionHeaderSchema, sessionEntrySchema]);

export const piSessionCheckpointSchema = z.object({
  version: z.literal(piCheckpointVersion).optional(),
  kind: z.string().optional(),
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  entries: z.array(piFileEntrySchema),
  runId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  workspaceGeneration: z.number().int().positive().optional(),
  generation: z.number().int().positive().optional(),
  assistantAttempt: z.number().int().nonnegative().optional(),
});

export type PiFileEntry = z.infer<typeof piFileEntrySchema>;
export type PiSessionCheckpoint = z.infer<typeof piSessionCheckpointSchema>;

export const storedPiSessionSchema = z.object({
  storage: z.literal("pi-session-entries-v1"),
  metadata: z.record(z.string(), jsonValueSchema),
  entryCount: z.number().int().nonnegative(),
});

export class InvalidPiCheckpointError extends Error {
  readonly code = "INVALID_CHECKPOINT" as const;

  constructor() {
    super("Saved Pi session checkpoint is invalid");
    this.name = "InvalidPiCheckpointError";
  }
}

function sanitizeAgentMessage(message: PiAgentMessage): PiAgentMessage {
  if (message.role === "assistant") {
    const { rawStopReason: _rawStopReason, ...safeMessage } = message;

    return {
      ...safeMessage,
      errorMessage:
        message.errorMessage === undefined ? undefined : publicFailureMessage(message.errorMessage),
      diagnostics: message.diagnostics?.map((diagnostic) => ({
        type: "error",
        timestamp: diagnostic.timestamp,
        error: diagnostic.error
          ? {
              message: publicFailureMessage(diagnostic.error.message),
            }
          : undefined,
      })),
    };
  }

  if (message.role === "toolResult" && message.isError) {
    const { content: _content, details: _details, ...safeMessage } = message;
    return {
      ...safeMessage,
      content: [{ type: "text", text: publicFailureMessage(undefined) }],
    };
  }

  return message;
}

function normalizeCheckpoint(checkpoint: PiSessionCheckpoint): PiSessionCheckpoint {
  return {
    ...checkpoint,
    entries: checkpoint.entries.map((entry) =>
      entry.type === "message" ? { ...entry, message: sanitizeAgentMessage(entry.message) } : entry,
    ),
  };
}

function validateEntryGraph(entries: PiFileEntry[]): void {
  const headerCount = entries.filter((entry) => entry.type === "session").length;
  if (headerCount !== 1 || entries[0]?.type !== "session") throw new InvalidPiCheckpointError();

  const ids = new Set<string>();
  const entryIds = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const id = entry.id;
    if (ids.has(id)) throw new InvalidPiCheckpointError();
    ids.add(id);
    if (entry.type === "session") continue;

    if (index === 1 && entry.parentId !== null) throw new InvalidPiCheckpointError();
    if (entry.parentId !== null && !entryIds.has(entry.parentId))
      throw new InvalidPiCheckpointError();
    if (entry.type === "compaction" && !entryIds.has(entry.firstKeptEntryId))
      throw new InvalidPiCheckpointError();
    if (entry.type === "branch_summary" && !entryIds.has(entry.fromId))
      throw new InvalidPiCheckpointError();
    if (entry.type === "label" && !entryIds.has(entry.targetId))
      throw new InvalidPiCheckpointError();
    entryIds.add(id);
  }
}

/** Decode and normalize the inline Pi checkpoint format used by the runner. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decode untrusted JSON at this single checkpoint boundary.
export function decodePiSessionCheckpoint(value: unknown): PiSessionCheckpoint {
  const parsed = piSessionCheckpointSchema.safeParse(value);
  if (!parsed.success) throw new InvalidPiCheckpointError();
  const header = parsed.data.entries[0];
  if (header?.type !== "session" || header.id !== parsed.data.sessionId)
    throw new InvalidPiCheckpointError();
  validateEntryGraph(parsed.data.entries);
  return normalizeCheckpoint({ ...parsed.data, version: piCheckpointVersion });
}

/** Decode a metadata row plus separately stored entry rows atomically loaded by the DB store. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decode untrusted JSON metadata at this single checkpoint boundary.
export function decodeStoredPiSessionCheckpoint(
  metadata: unknown,
  entries: unknown[],
  entryCount: number,
): PiSessionCheckpoint {
  if (!Number.isInteger(entryCount) || entryCount !== entries.length)
    throw new InvalidPiCheckpointError();
  const parsedMetadata = z.record(z.string(), jsonValueSchema).safeParse(metadata);
  if (!parsedMetadata.success) throw new InvalidPiCheckpointError();
  return decodePiSessionCheckpoint(Object.assign({}, parsedMetadata.data, { entries }));
}
