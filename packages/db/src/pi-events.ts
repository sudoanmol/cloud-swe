import { z } from "zod";

import { questionSchema } from "./question-contracts";

/**
 * Project-owned registry of durable thread event names.
 *
 * This module is browser-safe: it imports no database client, runner code, or
 * Pi provider catalog. Payload schemas are intentionally narrow. Unknown event
 * names remain replayable as unsupported markers, but a known event with a
 * malformed payload is a protocol error rather than silently ignored content.
 */
export const threadEventTypeSchema = z.enum([
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.cancel_requested",
  "assistant.started",
  "assistant.delta",
  "assistant.reasoning.delta",
  "assistant.message",
  "tool.started",
  "tool.output",
  "tool.completed",
  "questions.requested",
  "questions.answered",
  "questions.cancelled",
  "git.approval.requested",
  "git.approval.decided",
  "git.operation.updated",
  "workspace.provisioning",
  "workspace.running",
  "workspace.paused",
  "workspace.deleted",
  "workspace.failed",
  "workspace.quarantined",
  "workspace.recovery",
  "workspace.reset",
  "thread.title.updated",
]);

export type ThreadEventType = z.infer<typeof threadEventTypeSchema>;

export const runEventPayloadSchema = z.object({
  runId: z.string().min(1),
  messageId: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  turnRestored: z.boolean().optional(),
});

const currentAssistantStartedPayloadSchema = z.object({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  assistantAttempt: z.number().int().positive(),
  /** Absent on events produced before per-message boundaries existed. */
  messageIndex: z.number().int().positive().optional(),
});

const currentAssistantDeltaPayloadSchema = z.object({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  assistantAttempt: z.number().int().positive(),
  messageIndex: z.number().int().positive().optional(),
  deltaIndex: z.number().int().nonnegative(),
  delta: z.string().optional(),
  content: z.string().optional(),
});

// Historical scripted events used a numeric `delta` and no assistant ordinal.
// Match their exact shape so incomplete Pi message identities still fail closed.
const scriptedAssistantIdentity = z.strictObject({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
});

export const assistantStartedPayloadSchema = z.union([
  currentAssistantStartedPayloadSchema,
  scriptedAssistantIdentity.transform(
    (value): z.infer<typeof currentAssistantStartedPayloadSchema> => ({
      ...value,
      assistantAttempt: 1,
    }),
  ),
]);

export const assistantDeltaPayloadSchema = z.union([
  currentAssistantDeltaPayloadSchema,
  scriptedAssistantIdentity
    .extend({ delta: z.number().int().nonnegative(), content: z.string() })
    .transform((value): z.infer<typeof currentAssistantDeltaPayloadSchema> => ({
      runId: value.runId,
      attemptId: value.attemptId,
      assistantAttempt: 1,
      deltaIndex: value.delta,
      delta: value.content,
    })),
]);

/** Readable model reasoning for one assistant message; never the provider signature. */
export const assistantReasoningDeltaPayloadSchema = z.object({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  assistantAttempt: z.number().int().positive(),
  messageIndex: z.number().int().positive(),
  deltaIndex: z.number().int().nonnegative(),
  delta: z.string(),
});

export const assistantMessagePayloadSchema = z.object({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  assistantAttempt: z.number().int().positive(),
  messageIndex: z.number().int().positive(),
  content: z.string(),
  contentTruncated: z.boolean().optional(),
  reasoning: z.string().optional(),
  reasoningTruncated: z.boolean().optional(),
  stopReason: z.string().optional(),
});

export const questionsRequestedPayloadSchema = z.object({
  runId: z.string().min(1),
  requestId: z.string().min(1),
  request: z.object({
    id: z.string().min(1),
    toolCallId: z.string().min(1),
    questions: z.array(questionSchema).min(1).max(3),
  }),
});

export const questionsSettledPayloadSchema = z.object({
  runId: z.string().min(1),
  requestId: z.string().min(1),
  answers: z.record(z.string(), z.string()).nullable().optional(),
});

export const workspaceEventPayloadSchema = z.object({
  threadId: z.string().min(1),
  state: z.string().min(1),
  generation: z.number().int().positive().optional(),
  transitionId: z.string().nullable().optional(),
});

/**
 * `workspace.reset` carries the replacement facts, not a new workspace state.
 * It is a distinct payload from `workspace.<state>` lifecycle events.
 */
export const workspaceResetPayloadSchema = z.object({
  threadId: z.string().min(1),
  workspaceId: z.string().min(1),
  oldGeneration: z.number().int().positive(),
  newGeneration: z.number().int().positive(),
  reason: z.string(),
  resetTransitionId: z.string().nullable().optional(),
  unsettledOlderOperations: z.number().int().nonnegative().optional(),
  confirmedMissing: z.boolean().optional(),
  message: z.string(),
});

export const titleUpdatedPayloadSchema = z.object({
  title: z.string().min(1).max(80),
});

export type AssistantStartedPayload = z.infer<typeof assistantStartedPayloadSchema>;

export type AssistantDeltaPayload = z.infer<typeof assistantDeltaPayloadSchema>;

export type AssistantReasoningDeltaPayload = z.infer<typeof assistantReasoningDeltaPayloadSchema>;

export type AssistantMessagePayload = z.infer<typeof assistantMessagePayloadSchema>;

export type QuestionsRequestedPayload = z.infer<typeof questionsRequestedPayloadSchema>;
