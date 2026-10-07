import { z } from "zod";

/**
 * Browser-safe schemas for the `tool.*` event payloads produced by the runner.
 *
 * The server keeps its own richer diagnostics; these schemas only describe the
 * bounded public projection a transcript reader needs. Unknown payloads are
 * never silently interpreted as a different variant.
 */

export const commandOutcomeKindSchema = z.enum([
  "completed",
  "nonzero",
  "transport-timeout",
  "cancelled",
  "unknown",
  "output-limit",
]);

export type CommandOutcomeKind = z.infer<typeof commandOutcomeKindSchema>;

/** Final reconciled shell output. Live chunks use the incremental variant below. */
export const bashToolResultSchema = z.object({
  kind: commandOutcomeKindSchema,
  stdout: z.string(),
  stderr: z.string(),
  output: z.string().optional(),
  diagnostic: z.string().optional(),
  statusCode: z.number().nullable().optional(),
  outputTruncated: z.boolean().optional(),
});

export const readToolResultSchema = z.object({
  kind: z.literal("read"),
  path: z.string(),
  content: z.string().optional(),
  outputTruncated: z.boolean().optional(),
});

export const editToolResultSchema = z.object({
  kind: z.literal("edit"),
  path: z.string(),
  replacementCount: z.number().int().nonnegative(),
  unifiedDiff: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diffTruncated: z.boolean(),
  beforeHash: z.string(),
  afterHash: z.string(),
});

export const writeToolResultSchema = z.object({
  kind: z.literal("write"),
  path: z.string(),
  /** Explicit created/replaced fact reported by the guest, never inferred in the browser. */
  change: z.enum(["created", "replaced"]),
  bytes: z.number().int().nonnegative(),
  preview: z.string().optional(),
  previewBytes: z.number().int().nonnegative().optional(),
  previewTruncated: z.boolean().optional(),
});

export const mcpToolResultSchema = z.object({
  kind: z.literal("mcp"),
  server: z.string(),
  tool: z.string(),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
        data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
      }),
    ]),
  ),
  truncated: z.boolean(),
});

export const structuredToolResultSchema = z.discriminatedUnion("kind", [
  readToolResultSchema,
  editToolResultSchema,
  writeToolResultSchema,
  mcpToolResultSchema,
]);

export type StructuredToolResult = z.infer<typeof structuredToolResultSchema>;

/**
 * Incremental `tool.output` variant. Trailing fields are additive so an older
 * reader that only understands `output`/`diagnostic` keeps working.
 */
export const incrementalToolOutputSchema = z.object({
  toolCallId: z.string().min(1),
  incremental: z.literal(true),
  stream: z.enum(["stdout", "stderr"]),
  /** Byte offset of this chunk's first byte. */
  offset: z.number().int().nonnegative(),
  /** Bytes consumed by this chunk; the text may be empty for a split sequence. */
  bytes: z.number().int().nonnegative().optional(),
  /** `offset + bytes`: the next expected offset for this stream. */
  nextOffset: z.number().int().nonnegative().optional(),
  text: z.string(),
  commandId: z.string().optional(),
  callId: z.string().optional(),
});

export type IncrementalToolOutput = z.infer<typeof incrementalToolOutputSchema>;

/**
 * Final `tool.output` payload. It carries the reconciled bounded output and
 * optional truncation/diagnostic facts. Both live and final variants are
 * accepted so a reader can process mixed histories.
 */
const currentToolOutputPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  output: z.string().optional(),
  diagnostic: z.string().optional(),
  outputTruncated: z.boolean().optional(),
  truncated: z.boolean().optional(),
  partial: z.boolean().optional(),
  stream: z.enum(["stdout", "stderr"]).optional(),
  offset: z.number().int().nonnegative().optional(),
  text: z.string().optional(),
  incremental: z.boolean().optional(),
});

const currentToolStartedPayloadSchema = z.object({
  runId: z.string(),
  attemptId: z.string(),
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
});

const currentToolCompletedPayloadSchema = z.object({
  runId: z.string(),
  attemptId: z.string(),
  toolCallId: z.string().min(1),
  name: z.string().min(1).optional(),
  isError: z.boolean().optional(),
  result: z.unknown().optional(),
  kind: commandOutcomeKindSchema.optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  output: z.string().optional(),
  diagnostic: z.string().optional(),
  statusCode: z.number().nullable().optional(),
  outputTruncated: z.boolean().optional(),
});

// The scripted runner's historical events have one shell call per attempt and
// no toolCallId. Recognize that exact wire shape, not arbitrary missing fields.
const scriptedIdentity = z.object({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  toolCallId: z.undefined().optional(),
});

const scriptedToolCallId = "legacy-scripted-shell";

export const toolStartedPayloadSchema = z.union([
  currentToolStartedPayloadSchema,
  scriptedIdentity
    .extend({ name: z.literal("shell"), command: z.string() })
    .transform((value): z.infer<typeof currentToolStartedPayloadSchema> => ({
      runId: value.runId,
      attemptId: value.attemptId,
      toolCallId: scriptedToolCallId,
      name: "bash",
      args: { command: value.command },
    })),
]);

export const toolOutputPayloadSchema = z.union([
  currentToolOutputPayloadSchema,
  scriptedIdentity
    .extend({
      kind: z.enum([
        "completed",
        "failed",
        "transport-timeout",
        "cancelled",
        "unknown",
        "output-limit",
      ]),
      output: z.string(),
      stderr: z.string(),
      exitCode: z.number().int().nullable(),
      outputTruncated: z.boolean(),
      diagnostic: z.string().optional(),
    })
    .transform((value): z.infer<typeof currentToolOutputPayloadSchema> => ({
      ...value,
      toolCallId: scriptedToolCallId,
      output: [value.output, value.stderr].filter(Boolean).join("\n"),
    })),
]);

export const anyToolOutputPayloadSchema = z.union([
  incrementalToolOutputSchema,
  toolOutputPayloadSchema,
]);

export const toolCompletedPayloadSchema = z.union([
  currentToolCompletedPayloadSchema,
  scriptedIdentity
    .extend({
      name: z.literal("shell"),
      exitCode: z.number().int().nullable(),
      isError: z.boolean(),
    })
    .transform((value): z.infer<typeof currentToolCompletedPayloadSchema> => ({
      ...value,
      name: "bash",
      toolCallId: scriptedToolCallId,
      statusCode: value.exitCode,
      kind: value.exitCode === null ? "unknown" : value.exitCode === 0 ? "completed" : "nonzero",
    })),
]);

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof -- Persisted tool results and legacy stringified wrappers are untrusted JSON parsed only in this decoder. */
function asCandidate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();

  if (!trimmed.startsWith("{")) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // A truncated stringified wrapper is not structured; callers fall back to text.
    return null;
  }
}

/**
 * Decode structured public tool results.
 *
 * Structured results produced by the current runner carry an explicit `kind`.
 * Stringified results and `AgentToolResult` wrappers are validated before use. Anything else returns null and the
 * caller renders plain bounded text.
 */
export function decodeStructuredToolResult(value: unknown): StructuredToolResult | null {
  const candidate = asCandidate(value);

  if (candidate === null) return null;
  const current = structuredToolResultSchema.safeParse(candidate);

  /* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof */

  if (current.success) return current.data;

  return null;
}
