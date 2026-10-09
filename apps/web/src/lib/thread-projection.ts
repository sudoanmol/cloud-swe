import {
  decodeStructuredToolResult,
  incrementalToolOutputSchema,
  toolOutputPayloadSchema,
  toolStartedPayloadSchema,
  toolCompletedPayloadSchema,
} from "@cloud-swe/db/tool-events";
import {
  contextCompactedPayloadSchema,
  steeredMessagePayloadSchema,
  assistantDeltaPayloadSchema,
  assistantMessagePayloadSchema,
  assistantReasoningDeltaPayloadSchema,
  assistantStartedPayloadSchema,
  type AssistantUsage,
  diffUpdatedPayloadSchema,
  browserOwnerChangedPayloadSchema,
  runEventPayloadSchema,
  questionsSettledPayloadSchema,
  titleUpdatedPayloadSchema,
  workspaceEventPayloadSchema,
  workspaceResetPayloadSchema,
} from "@cloud-swe/db/pi-events";
import {
  workspaceStateSchema,
  type RunStatus,
  type ThreadSnapshot,
} from "@cloud-swe/api/contracts";
import { ThreadApiError, type ThreadStreamEvent } from "@cloud-swe/api/client";
import { validateKnownThreadEvent } from "@cloud-swe/api/events";
import { z } from "zod";

import type {
  LegacyCommandResult,
  ProjectedMarkerPart,
  ProjectedRun,
  ProjectedTextPart,
  ProjectedToolPart,
  ProjectionPart,
  ThreadProjection,
  ThreadUsage,
} from "./chat-types";

/**
 * Pure replay projection over committed thread events.
 *
 * A fresh projection starts at sequence zero: the snapshot cursor is a summary
 * watermark and never seeds this cursor, because doing so would skip all tool
 * history and partial assistant text. Only increasing sequences are applied.
 */
const MAX_UNSUPPORTED_MARKERS = 8;

const MAX_LIVE_TEXT = 64_000;

/** Tools whose completion may change workspace files. */
const mutatingTools = new Set(["bash", "edit", "write"]);

export function emptyProjection(threadId: string | null): ThreadProjection {
  return {
    threadId,
    cursor: 0,
    title: null,
    titleVersion: 0,
    runs: [],
    workspace: null,
    workspaceSequence: 0,
    diffStat: null,
    browser: { active: false, owner: "agent" },
    editSequence: 0,
    usage: null,
    notices: [],
    unsupported: [],
  };
}

/**
 * Sums every provider call, retries included, since each one was billed. The
 * latest call's prompt plus reply is what the next call starts from.
 */
function addUsage(totals: ThreadUsage | null, call: AssistantUsage): ThreadUsage {
  return {
    input: (totals?.input ?? 0) + call.input,
    output: (totals?.output ?? 0) + call.output,
    cacheRead: (totals?.cacheRead ?? 0) + call.cacheRead,
    cacheWrite: (totals?.cacheWrite ?? 0) + call.cacheWrite,
    cost: (totals?.cost ?? 0) + call.cost,
    contextTokens: call.input + call.output + call.cacheRead + call.cacheWrite,
  };
}

/** Copy-on-write run update: the previous projection stays valid. */
function updateRun(
  projection: ThreadProjection,
  runId: string,
  update: (run: ProjectedRun) => ProjectedRun,
): ProjectedRun[] {
  const index = projection.runs.findIndex((run) => run.runId === runId);
  const base = index >= 0 ? projection.runs[index] : undefined;

  const next = update({
    runId,
    status: base?.status ?? "unknown",
    statusSequence: base?.statusSequence ?? 0,
    error: base?.error ?? null,
    attemptId: base?.attemptId ?? null,
    parts: base ? [...base.parts] : [],
  });

  if (index < 0) return [...projection.runs, next];

  const runs = [...projection.runs];

  runs[index] = next;

  return runs;
}

function textKey(
  runId: string,
  attemptId: string,
  assistantAttempt: number,
  messageIndex: number,
): string {
  return JSON.stringify([runId, attemptId, assistantAttempt, messageIndex]);
}

function upsertTextPart(
  run: ProjectedRun,
  input: {
    attemptId: string;
    assistantAttempt: number;
    messageIndex?: number | undefined;
  },
  update: (part: ProjectedTextPart) => ProjectedTextPart,
): ProjectionPart[] {
  const last = run.parts.at(-1);

  const legacyIndex =
    input.messageIndex === undefined &&
    last?.kind === "text" &&
    last.legacy &&
    last.identity.attemptId === input.attemptId &&
    last.identity.assistantAttempt === input.assistantAttempt
      ? run.parts.length - 1
      : -1;

  const messageIndex = input.messageIndex ?? run.parts.length + 1;
  const key = textKey(run.runId, input.attemptId, input.assistantAttempt, messageIndex);

  const index =
    input.messageIndex === undefined
      ? legacyIndex
      : run.parts.findIndex((part) => part.kind === "text" && part.key === key);

  const parts = [...run.parts];

  if (index >= 0) {
    const existing = parts[index];

    if (existing?.kind === "text") {
      parts[index] = update(existing);

      return parts;
    }
  }

  parts.push(
    update({
      kind: "text",
      key,
      identity: {
        attemptId: input.attemptId,
        assistantAttempt: input.assistantAttempt,
        messageIndex,
      },
      legacy: input.messageIndex === undefined,
      text: "",
      state: "streaming",
      truncated: false,
    }),
  );

  return parts;
}

function upsertToolPart(
  run: ProjectedRun,
  toolCallId: string,
  attemptId: string,
  name: string,
  update: (part: ProjectedToolPart) => ProjectedToolPart,
): ProjectionPart[] {
  const index = run.parts.findIndex(
    (part) =>
      part.kind === "tool" && part.toolCallId === toolCallId && part.attemptId === attemptId,
  );

  const parts = [...run.parts];

  if (index >= 0) {
    const existing = parts[index];

    if (existing?.kind === "tool") {
      parts[index] = update(existing);

      return parts;
    }
  }

  parts.push(
    update({
      kind: "tool",
      key: JSON.stringify([run.runId, attemptId, toolCallId]),
      toolCallId,
      attemptId,
      name,
      state: "running",
      args: undefined,
      structured: null,
      legacy: null,
      live: { stdout: "", stderr: "", truncated: false },
      nextOffset: { stdout: 0, stderr: 0 },
      finalOutput: null,
      diagnostic: null,
    }),
  );

  return parts;
}

function appendLive(
  part: ProjectedToolPart,
  stream: "stdout" | "stderr",
  text: string,
  offset: number,
  nextOffset: number | undefined,
): ProjectedToolPart {
  // Byte offsets advance independently of decoded text, so a split UTF-8
  // sequence still moves the cursor. A chunk at or behind the cursor is a
  // duplicate; the final reconciled output replaces the preview anyway.
  if (offset < part.nextOffset[stream]) return part;

  if (offset > part.nextOffset[stream])
    return {
      ...part,
      live: { ...part.live, truncated: true },
      diagnostic: "Live output has a gap; final output will replace it.",
    };

  if (nextOffset !== undefined && nextOffset < offset)
    throw new ThreadApiError(500, "PROTOCOL_ERROR", "Invalid command output byte range");

  const combined = part.live[stream] + text;
  const bounded = combined.length > MAX_LIVE_TEXT;

  const live = {
    ...part.live,
    [stream]: bounded ? combined.slice(-MAX_LIVE_TEXT) : combined,
    truncated: part.live.truncated || bounded,
  };

  return {
    ...part,
    live,
    nextOffset: {
      ...part.nextOffset,
      [stream]: nextOffset ?? offset + new TextEncoder().encode(text).byteLength,
    },
  };
}

function marker(key: string, text: string, tone: ProjectedMarkerPart["tone"]): ProjectedMarkerPart {
  return { kind: "marker", key, text, tone };
}

function legacyCommandResult(
  payload: z.infer<typeof toolCompletedPayloadSchema>,
): LegacyCommandResult | null {
  if (!payload.kind) return null;

  return {
    kind: payload.kind,
    stdout: payload.stdout ?? "",
    stderr: payload.stderr ?? "",
    output: payload.output ?? "",
    diagnostic: payload.diagnostic ?? null,
    statusCode: payload.statusCode ?? null,
    outputTruncated: payload.outputTruncated === true,
  };
}

const eventIdentitySchema = z.object({ runId: z.string().min(1), attemptId: z.string().min(1) });

/** Applies one committed event. Non-increasing sequences are ignored. */
export function applyThreadEvent(
  projection: ThreadProjection,
  event: ThreadStreamEvent,
): ThreadProjection {
  if (event.sequence <= projection.cursor) return projection;

  if (event.sequence !== projection.cursor + 1)
    throw new ThreadApiError(
      409,
      "EVENT_GAP",
      "Event sequence gap; reconnecting from the last applied event",
    );
  validateKnownThreadEvent(event);

  const next: ThreadProjection = { ...projection, cursor: event.sequence };

  switch (event.type) {
    case "skills.discovered":
      return next;
    case "browser.activity_started":
    case "browser.activity_stopped":
      return {
        ...next,
        browser: { ...next.browser, active: event.type === "browser.activity_started" },
      };
    case "browser.owner_changed":
      return {
        ...next,
        browser: {
          ...next.browser,
          owner: browserOwnerChangedPayloadSchema.parse(event.payload).owner,
        },
      };
    case "diff.updated": {
      const parsed = diffUpdatedPayloadSchema.safeParse(event.payload);

      if (!parsed.success) return next;

      return { ...next, diffStat: parsed.data };
    }

    case "thread.title.updated": {
      const parsed = titleUpdatedPayloadSchema.safeParse(event.payload);

      if (!parsed.success) return next;

      return { ...next, title: parsed.data.title, titleVersion: event.sequence };
    }

    case "message.pending":
    case "message.pending.updated":
      return next;
    case "message.steered": {
      const payload = steeredMessagePayloadSchema.parse(event.payload);

      return {
        ...next,
        runs: updateRun(next, payload.runId, (run) => ({
          ...run,
          parts: [
            ...run.parts,
            {
              kind: "user",
              key: `message:${payload.messageId}`,
              messageId: payload.messageId,
              text: payload.content,
              createdAt: null,
              attachments: payload.attachments,
              delivery: "sent",
              runId: payload.runId,
              clientMessageId: payload.clientMessageId,
            },
          ],
        })),
      };
    }

    case "context.compacted": {
      const payload = contextCompactedPayloadSchema.parse(event.payload);
      const totals = payload.usage ? addUsage(next.usage, payload.usage) : next.usage;

      return {
        ...next,
        usage: {
          ...(totals ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
          contextTokens: payload.contextTokens,
        },
        runs: updateRun(next, payload.runId, (run) => ({
          ...run,
          parts: [
            ...run.parts,
            {
              kind: "marker",
              key: `compaction:${payload.entryId}`,
              text: "Context compacted",
              tone: "info",
            },
          ],
        })),
      };
    }

    case "assistant.started": {
      const parsed = assistantStartedPayloadSchema.safeParse(event.payload);

      if (!parsed.success) return next;

      return {
        ...next,
        runs: updateRun(next, parsed.data.runId, (run) => ({
          ...run,
          attemptId: parsed.data.attemptId,
          parts: upsertTextPart(
            {
              ...run,
              // Arrival order establishes attempt replacement; IDs are opaque.
              parts:
                (run.attemptId && run.attemptId !== parsed.data.attemptId) ||
                run.parts.some(
                  (part) =>
                    part.kind === "text" &&
                    part.state !== "final" &&
                    part.identity.assistantAttempt !== parsed.data.assistantAttempt,
                )
                  ? run.parts.filter(
                      (part) =>
                        part.kind === "marker" ||
                        part.kind === "user" ||
                        (part.kind === "text" ? part.state === "final" : part.state !== "running"),
                    )
                  : run.parts,
            },
            parsed.data,
            (part) => ({ ...part, state: "streaming" }),
          ),
        })),
      };
    }

    case "assistant.delta": {
      const parsed = assistantDeltaPayloadSchema.safeParse(event.payload);

      if (!parsed.success) return next;

      const delta = parsed.data.delta ?? parsed.data.content;

      if (delta === undefined)
        throw new ThreadApiError(500, "PROTOCOL_ERROR", "Assistant delta has no text");

      return {
        ...next,
        runs: updateRun(next, parsed.data.runId, (run) => ({
          ...run,
          attemptId: parsed.data.attemptId,
          parts: upsertTextPart(run, parsed.data, (part) => ({
            ...part,
            text: part.text + delta,
            state: "streaming",
            truncated: part.truncated,
          })),
        })),
      };
    }

    case "assistant.reasoning.delta": {
      const parsed = assistantReasoningDeltaPayloadSchema.safeParse(event.payload);

      if (!parsed.success) return next;

      return {
        ...next,
        runs: updateRun(next, parsed.data.runId, (run) => ({
          ...run,
          attemptId: parsed.data.attemptId,
          parts: upsertTextPart(run, parsed.data, (part) => ({
            ...part,
            reasoning: (part.reasoning ?? "") + parsed.data.delta,
          })),
        })),
      };
    }

    case "assistant.message": {
      const parsed = assistantMessagePayloadSchema.safeParse(event.payload);

      if (!parsed.success) return next;
      const call = parsed.data.usage;

      return {
        ...next,
        usage: call ? addUsage(next.usage, call) : next.usage,
        runs: updateRun(next, parsed.data.runId, (run) => ({
          ...run,
          attemptId: parsed.data.attemptId,
          parts: upsertTextPart(run, parsed.data, (part) => ({
            ...part,
            // The boundary event carries the authoritative content.
            text:
              parsed.data.contentTruncated && part.text.startsWith(parsed.data.content)
                ? part.text
                : parsed.data.content,
            // A truncated final copy never shrinks reasoning already streamed in full.
            reasoning:
              parsed.data.reasoningTruncated &&
              part.reasoning?.startsWith(parsed.data.reasoning ?? "")
                ? part.reasoning
                : (parsed.data.reasoning ?? part.reasoning),
            state:
              parsed.data.stopReason === "error" || parsed.data.stopReason === "aborted"
                ? "partial"
                : "final",
            truncated: parsed.data.contentTruncated === true,
            stopReason: parsed.data.stopReason,
          })),
        })),
      };
    }

    case "tool.started": {
      const parsed = toolStartedPayloadSchema.safeParse(event.payload);

      if (!parsed.success) return next;

      return {
        ...next,
        runs: updateRun(next, parsed.data.runId, (run) => ({
          ...run,
          attemptId: parsed.data.attemptId,
          parts: upsertToolPart(
            {
              ...run,
              parts: run.parts.map((part) =>
                part.kind === "text" && part.legacy && part.state === "streaming"
                  ? { ...part, state: "final" }
                  : part,
              ),
            },
            parsed.data.toolCallId,
            parsed.data.attemptId,
            parsed.data.name,
            (part) => ({
              ...part,
              args: parsed.data.args,
            }),
          ),
        })),
      };
    }

    case "tool.output": {
      const { runId, attemptId } = eventIdentitySchema.parse(event.payload);
      const incremental = incrementalToolOutputSchema.safeParse(event.payload);

      if (
        !incremental.success &&
        z.object({ incremental: z.literal(true) }).safeParse(event.payload).success
      )
        throw new ThreadApiError(500, "PROTOCOL_ERROR", "Malformed incremental command output");

      if (incremental.success) {
        const chunk = incremental.data;

        return {
          ...next,
          runs: updateRun(next, runId, (run) => ({
            ...run,
            parts: upsertToolPart(run, chunk.toolCallId, attemptId, chunk.toolCallId, (part) =>
              appendLive(part, chunk.stream, chunk.text, chunk.offset, chunk.nextOffset),
            ),
          })),
        };
      }

      const final = toolOutputPayloadSchema.safeParse(event.payload);

      if (!final.success) return next;
      const payload = final.data;

      return {
        ...next,
        runs: updateRun(next, runId, (run) => ({
          ...run,
          parts: upsertToolPart(run, payload.toolCallId, attemptId, payload.toolCallId, (part) => ({
            ...part,
            finalOutput: payload.partial
              ? part.finalOutput
              : (payload.output ?? payload.text ?? part.finalOutput),
            diagnostic: payload.diagnostic ?? null,
            live: {
              ...part.live,
              truncated: part.live.truncated || payload.outputTruncated === true,
            },
          })),
        })),
      };
    }

    case "tool.completed": {
      const payload = toolCompletedPayloadSchema.parse(event.payload);

      return {
        ...next,
        editSequence: mutatingTools.has(payload.name ?? "") ? event.sequence : next.editSequence,
        runs: updateRun(next, payload.runId, (run) => ({
          ...run,
          attemptId: payload.attemptId,
          parts: upsertToolPart(
            run,
            payload.toolCallId,
            payload.attemptId,
            payload.name ?? payload.toolCallId,
            (part) => {
              const name = payload.name ?? part.name;
              const legacy = legacyCommandResult(payload);
              // The final reconciled output replaces the live preview.

              return {
                ...part,
                name,
                state:
                  payload.isError ||
                  (payload.kind && payload.kind !== "completed") ||
                  (payload.statusCode !== undefined &&
                    payload.statusCode !== null &&
                    payload.statusCode !== 0)
                    ? "failed"
                    : "completed",
                structured: decodeStructuredToolResult(payload.result ?? payload.output, name),
                legacy: legacy ?? part.legacy,
                finalOutput: payload.output ?? part.finalOutput,
                diagnostic: payload.diagnostic ?? part.diagnostic,
                live: { stdout: "", stderr: "", truncated: payload.outputTruncated ?? false },
              };
            },
          ),
        })),
      };
    }

    case "run.queued":
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "run.cancel_requested": {
      const parsed = runEventPayloadSchema.safeParse(event.payload);

      if (!parsed.success) return next;
      const status = statusFromRunEventType(event.type);

      return {
        ...next,
        runs: updateRun(next, parsed.data.runId, (run) => ({
          ...run,
          status: status ?? run.status,
          statusSequence: status ? event.sequence : run.statusSequence,
          parts:
            status === "failed" || status === "cancelled"
              ? run.parts.map((part) =>
                  part.kind === "text" && part.state === "streaming"
                    ? { ...part, state: "partial" }
                    : part,
                )
              : run.parts,
          error: parsed.data.error ?? run.error,
        })),
      };
    }

    case "git.approval.requested":
    case "git.approval.decided":
    case "git.operation.updated": {
      if (event.type !== "git.approval.requested") return next;

      const { runId, operationId } = z
        .object({ runId: z.string(), operationId: z.uuid() })
        .parse(event.payload);

      return {
        ...next,
        runs: updateRun(next, runId, (run) => ({
          ...run,
          parts: [
            ...run.parts,
            {
              ...marker(`git:${operationId}`, "Git approval", "info"),
              gitOperationId: operationId,
            },
          ],
        })),
      };
    }

    case "workspace.reset": {
      const parsed = workspaceResetPayloadSchema.safeParse(event.payload);

      if (!parsed.success) return next;

      return {
        ...next,
        workspace: { state: "recovery", generation: parsed.data.newGeneration },
        workspaceSequence: event.sequence,
        // The replaced filesystem no longer has the counted changes.
        diffStat: null,
        browser: { ...next.browser, active: false },
        notices: [
          ...next.notices,
          marker(
            `reset:${event.sequence}`,
            `${parsed.data.message} Uncommitted files and unpushed commits may be lost.`,
            "warning",
          ),
        ],
      };
    }

    case "questions.requested":
    case "questions.answered":
    case "questions.cancelled": {
      const { runId, requestId } = questionsSettledPayloadSchema.parse(event.payload);

      return {
        ...next,
        runs: updateRun(next, runId, (run) => ({
          ...run,
          parts: [
            ...run.parts,
            {
              ...marker(
                `question:${event.sequence}`,
                event.type === "questions.requested"
                  ? "Waiting for your answers"
                  : event.type === "questions.cancelled"
                    ? "Question cancelled"
                    : "Answers accepted; waiting to resume",
                "info",
              ),
              questionRequestId: event.type === "questions.requested" ? requestId : undefined,
            },
          ],
        })),
      };
    }

    default: {
      const workspaceState = workspaceStateFromEventType(event.type);

      if (workspaceState) {
        const parsed = workspaceEventPayloadSchema.safeParse(event.payload);

        if (parsed.success)
          return {
            ...next,
            workspaceSequence: event.sequence,
            workspace: {
              state: workspaceState,
              generation: parsed.data.generation ?? next.workspace?.generation ?? null,
            },
          };

        return next;
      }

      if (next.unsupported.length >= MAX_UNSUPPORTED_MARKERS) return next;

      return {
        ...next,
        unsupported: [...next.unsupported, `Unsupported event: ${event.type}`],
      };
    }
  }
}

function workspaceStateFromEventType(type: string): string | null {
  if (!type.startsWith("workspace.")) return null;

  return workspaceStateSchema.safeParse(type.slice("workspace.".length)).data ?? null;
}

function statusFromRunEventType(type: string): RunStatus | null {
  switch (type) {
    case "run.queued":
      return "queued";
    case "run.started":
      return "running";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    default:
      return null;
  }
}

export function applyThreadEvents(
  projection: ThreadProjection,
  events: readonly ThreadStreamEvent[],
): ThreadProjection {
  return events.reduce(applyThreadEvent, projection);
}

/** REST can finish out of order; never replace a newer committed snapshot. */
export function retainNewestSnapshot(
  previous: ThreadSnapshot | undefined,
  incoming: ThreadSnapshot,
): ThreadSnapshot {
  return previous?.id === incoming.id &&
    (previous.latestEventId ?? 0) > (incoming.latestEventId ?? 0)
    ? previous
    : incoming;
}

/** Replay rebuilds history independently; only newer facts override a snapshot. */
export function reconcileThreadSnapshot(
  snapshot: ThreadSnapshot,
  projection: ThreadProjection,
): ThreadSnapshot {
  if (snapshot.id !== projection.threadId) return snapshot;
  const watermark = snapshot.latestEventId ?? 0;
  const state = workspaceStateSchema.safeParse(projection.workspace?.state);
  const projectedByRun = new Map(projection.runs.map((run) => [run.runId, run]));

  return {
    ...snapshot,
    title: projection.titleVersion > watermark ? projection.title : snapshot.title,
    runs: snapshot.runs.map((run) => {
      const projected = projectedByRun.get(run.id);

      return projected && projected.statusSequence > watermark && projected.status !== "unknown"
        ? { ...run, status: projected.status, error: projected.error }
        : run;
    }),
    workspace:
      snapshot.workspace && projection.workspaceSequence > watermark && state.success
        ? {
            ...snapshot.workspace,
            state: state.data,
            generation: Math.max(
              snapshot.workspace.generation,
              projection.workspace?.generation ?? 0,
            ),
          }
        : snapshot.workspace,
    // Do not advance the REST watermark: it does not cover replayed facts.
  };
}

/**
 * Which cached queries a batch of events makes stale. The snapshot watermark
 * proves only the snapshot covers an event; the question list is fetched
 * separately, so question events always refresh it.
 */
export function staleQueries(
  events: readonly { sequence: number; type: string }[],
  snapshotWatermark: number,
) {
  return {
    snapshot: events.some(
      (event) =>
        event.sequence > snapshotWatermark &&
        (event.type.startsWith("run.") ||
          event.type.startsWith("message.") ||
          event.type.startsWith("questions.") ||
          event.type.startsWith("workspace.") ||
          event.type === "thread.title.updated"),
    ),
    questions: events.some((event) => event.type.startsWith("questions.")),
  };
}
