import { z } from "zod";

import {
  assistantDeltaPayloadSchema,
  assistantMessagePayloadSchema,
  assistantStartedPayloadSchema,
  questionsRequestedPayloadSchema,
  questionsSettledPayloadSchema,
  runEventPayloadSchema,
  titleUpdatedPayloadSchema,
  workspaceEventPayloadSchema,
  workspaceResetPayloadSchema,
} from "@cloud-swe/db/pi-events";
import {
  anyToolOutputPayloadSchema,
  toolCompletedPayloadSchema,
  toolStartedPayloadSchema,
} from "@cloud-swe/db/tool-events";

import type { ThreadStreamEvent } from "./client";
import { ThreadApiError } from "./client";

/**
 * Known durable event payload schemas.
 *
 * A known event name with a malformed payload is a protocol error. An unknown
 * future event name is not: it advances the cursor with an unsupported marker
 * so a newer backend cannot stall an older reader.
 */
const workspaceStates = [
  "provisioning",
  "running",
  "paused",
  "deleted",
  "failed",
  "quarantined",
  "recovery",
] as const;

const knownThreadEventPayloadSchemas = new Map<string, z.ZodType>([
  ["run.queued", runEventPayloadSchema],
  ["run.started", runEventPayloadSchema],
  ["run.completed", runEventPayloadSchema],
  ["run.failed", runEventPayloadSchema],
  ["run.cancelled", runEventPayloadSchema],
  ["run.cancel_requested", runEventPayloadSchema],
  ["assistant.started", assistantStartedPayloadSchema],
  ["assistant.delta", assistantDeltaPayloadSchema],
  ["assistant.message", assistantMessagePayloadSchema],
  ["tool.started", toolStartedPayloadSchema],
  ["tool.output", anyToolOutputPayloadSchema],
  ["tool.completed", toolCompletedPayloadSchema],
  ["questions.requested", questionsRequestedPayloadSchema],
  ["questions.answered", questionsSettledPayloadSchema],
  ["questions.cancelled", questionsSettledPayloadSchema],
  ["workspace.reset", workspaceResetPayloadSchema],
  ["thread.title.updated", titleUpdatedPayloadSchema],
  ...workspaceStates.map((state) => [`workspace.${state}`, workspaceEventPayloadSchema] as const),
  // Git approval payloads carry server-owned proposal/decision records the
  // browser does not interpret; decisions stay out of scope in this pass.
  ["git.approval.requested", z.unknown()],
  ["git.approval.decided", z.unknown()],
  ["git.operation.updated", z.unknown()],
]);

export function isKnownThreadEventType(type: string): boolean {
  return knownThreadEventPayloadSchemas.has(type);
}

/**
 * Validate a known event payload. Unknown event names and git proposal
 * payloads (which carry server-owned proposal records the browser does not
 * interpret) are left untouched.
 */
export function validateKnownThreadEvent(event: ThreadStreamEvent): void {
  const schema = knownThreadEventPayloadSchemas.get(event.type);

  if (!schema) return;

  if (!schema.safeParse(event.payload).success)
    throw new ThreadApiError(500, "PROTOCOL_ERROR", `Malformed ${event.type} event payload`);
}
