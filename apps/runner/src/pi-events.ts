import { Match } from "effect";
import { z } from "zod";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { jsonValueSchema, type JsonObject } from "@cloud-swe/db/json";
import { publicFailureMessage } from "@cloud-swe/db/public-failure";
import { decodeStructuredToolResult } from "@cloud-swe/db/tool-events";
import {
  boundedValue,
  commandPayload,
  fingerprint,
  type PiCommandDiagnostic,
} from "./pi-command.js";
import { boundedUtf8 } from "./text.js";

/** Streamed text is coalesced for at most this long before it is written. */
const deltaFlushMs = 100;

const deltaFlushChars = 4_096;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate SDK tool arguments before projecting bounded event metadata.
function boundedEditArgs(args: unknown) {
  const parsed = z
    .object({
      path: z.string(),
      edits: z.array(z.object({ oldText: z.string(), newText: z.string() })),
    })
    .safeParse(args);

  if (!parsed.success) return { invalid: true };

  return {
    path: parsed.data.path.slice(0, 4096),
    edits: parsed.data.edits.length,
    oldTextBytes: parsed.data.edits.reduce((sum, edit) => sum + Buffer.byteLength(edit.oldText), 0),
    newTextBytes: parsed.data.edits.reduce((sum, edit) => sum + Buffer.byteLength(edit.newText), 0),
  };
}

/** Bound the durable write preview; the full arguments stay in the Pi checkpoint. */
const writeArgumentPreviewBytes = 4_096;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate SDK tool arguments before projecting bounded event metadata.
function boundedWriteArgs(args: unknown) {
  const parsed = z.object({ path: z.string(), content: z.string() }).safeParse(args);

  if (!parsed.success) return { invalid: true };

  const preview = boundedUtf8(parsed.data.content, writeArgumentPreviewBytes);

  return {
    path: parsed.data.path.slice(0, 4096),
    contentBytes: Buffer.byteLength(parsed.data.content),
    contentPreview: preview.text,
    contentPreviewTruncated: preview.truncated,
  };
}

/**
 * Project allowlisted structured tool details for the transcript.
 *
 * Editing and web tools already return bounded `details`; the decoder also
 * normalizes legacy shapes and rejects truncated stringified wrappers so a
 * reader falls back to plain text instead of parsing invalid JSON.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate SDK tool details at the runner event boundary.
function structuredToolResult(toolName: string, result: unknown) {
  const wrapper = z.object({ details: z.unknown() }).safeParse(result);

  return decodeStructuredToolResult(wrapper.success ? wrapper.data.details : result, toolName);
}

export type PiEventType =
  | "assistant.started"
  | "assistant.delta"
  | "assistant.reasoning.delta"
  | "assistant.message"
  | "tool.started"
  | "tool.output"
  | "tool.completed";

export interface PiEvent {
  type: PiEventType;
  dedupeKey: string;
  payload: JsonObject;
}

export function piAttemptEventIdentity(runId: string, attemptId: string): string {
  return `run:${runId}:attempt:${attemptId}`;
}

export interface AttemptScopedEvent {
  type: string;
  dedupeKey: string;
  payload: JsonObject;
}

/**
 * Envelope for Pi events. Pi already scopes its dedupe keys and payload to
 * the attempt, so the key passes through once while the activity-owned run
 * and attempt ids win over anything in the payload.
 */
export function scopePiAttemptEvent(
  runId: string,
  attemptId: string,
  event: AttemptScopedEvent,
): AttemptScopedEvent {
  return {
    type: event.type,
    payload: { ...event.payload, runId, attemptId },
    dedupeKey: event.dedupeKey,
  };
}

/** Scripted events carry no attempt identity, so the activity adds its scope. */
export function scopeScriptedAttemptEvent(
  runId: string,
  attemptId: string,
  event: AttemptScopedEvent,
): AttemptScopedEvent {
  return {
    type: event.type,
    payload: { ...event.payload, runId, attemptId },
    dedupeKey: `${piAttemptEventIdentity(runId, attemptId)}:${event.dedupeKey}`,
  };
}

export function assistantStartedDedupeKey(
  runId: string,
  attemptId: string,
  assistantAttempt: number,
  messageIndex: number,
): string {
  return `${piAttemptEventIdentity(runId, attemptId)}:assistant:${assistantAttempt}:${messageIndex}:started`;
}

export function assistantDeltaDedupeKey(
  runId: string,
  attemptId: string,
  assistantAttempt: number,
  messageIndex: number,
  deltaIndex: number,
): string {
  return `${piAttemptEventIdentity(runId, attemptId)}:assistant:${assistantAttempt}:${messageIndex}:delta:${deltaIndex}`;
}

export interface PiEventProjectorOptions {
  runId: string;
  attemptId: string;
  outputMaxBytes: number;
  /** Persists one project-owned event; ordering is the caller's writer queue. */
  queueEvent: (type: PiEventType, dedupeKey: string, payload: JsonObject) => void;
  /** Bounded remote-command outcomes by tool call, recorded before Pi sees the tool result. */
  toolOutcomes: ReadonlyMap<string, PiCommandDiagnostic>;
}

type SessionEventOf<Type extends AgentSessionEvent["type"]> = Extract<
  AgentSessionEvent,
  { type: Type }
>;

type AssistantMessage = Extract<SessionEventOf<"message_end">["message"], { role: "assistant" }>;

type AssistantDeltaType = "assistant.delta" | "assistant.reasoning.delta";

/**
 * Translates SDK session events into the project's durable Pi events and
 * coalesces streamed text. It owns the turn, message and delta counters that
 * make event identities unique within an attempt.
 */
export function createPiEventProjector(options: PiEventProjectorOptions) {
  const { runId, attemptId, outputMaxBytes, queueEvent, toolOutcomes } = options;
  const eventIdentity = piAttemptEventIdentity(runId, attemptId);
  let toolOutputIndex = 0;
  let deltaIndex = 0;
  /**
   * Turn identity: increments once per SDK agent start, so a retried or
   * continued turn never shares an assistant identity with an earlier one.
   * A question continuation is a new activity attempt with a fresh id.
   */
  let assistantAttempt = 0;
  /** Per-assistant-message index inside one turn attempt, starting at 1. */
  let messageIndex = 0;
  /** Last streamed thinking block of the current message, to separate blocks. */
  let reasoningContentIndex: number | undefined;

  /**
   * Providers stream a few characters per delta. Consecutive pieces of one
   * kind for one message are written as a single delta event; readers only
   * concatenate, so the projected text is unchanged.
   */
  let pendingDelta:
    | {
        type: AssistantDeltaType;
        assistantAttempt: number;
        messageIndex: number;
        text: string;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  const flushDelta = (): void => {
    if (!pendingDelta) return;
    const { type, assistantAttempt: turn, messageIndex: index, text, timer } = pendingDelta;
    pendingDelta = undefined;
    clearTimeout(timer);
    const currentDeltaIndex = deltaIndex++;

    if (type === "assistant.delta")
      queueEvent(type, assistantDeltaDedupeKey(runId, attemptId, turn, index, currentDeltaIndex), {
        assistantAttempt: turn,
        messageIndex: index,
        deltaIndex: currentDeltaIndex,
        delta: text,
        content: text,
      });
    else
      queueEvent(
        type,
        `${eventIdentity}:assistant:${turn}:${index}:reasoning:${currentDeltaIndex}`,
        {
          assistantAttempt: turn,
          messageIndex: index,
          deltaIndex: currentDeltaIndex,
          delta: text,
        },
      );
  };

  const bufferDelta = (type: AssistantDeltaType, text: string) => {
    const index = Math.max(1, messageIndex);

    if (
      pendingDelta &&
      (pendingDelta.type !== type ||
        pendingDelta.assistantAttempt !== assistantAttempt ||
        pendingDelta.messageIndex !== index)
    )
      flushDelta();

    if (pendingDelta) pendingDelta.text += text;
    else
      pendingDelta = {
        type,
        assistantAttempt,
        messageIndex: index,
        text,
        timer: setTimeout(flushDelta, deltaFlushMs),
      };

    if (pendingDelta.text.length >= deltaFlushChars) flushDelta();
  };

  // A new assistant message inside the turn opens its own boundary. Only the
  // same (turn, message) identity supersedes earlier partial text; a later
  // message never erases earlier commentary or the tool calls between them.
  const onMessageStart = (): void => {
    messageIndex += 1;
    reasoningContentIndex = undefined;
    queueEvent(
      "assistant.started",
      assistantStartedDedupeKey(runId, attemptId, assistantAttempt, messageIndex),
      { assistantAttempt, messageIndex },
    );
  };

  // The completed message is authoritative for that boundary; the streamed
  // deltas remain available for the live preview.
  const onMessageEnd = (message: AssistantMessage): void => {
    const content = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");

    const bounded = boundedUtf8(content, outputMaxBytes);

    // Only the readable reasoning text; the signature is opaque provider state.
    const reasoning = boundedUtf8(
      message.content
        .filter((part) => part.type === "thinking")
        .map((part) => part.thinking.trim())
        .filter(Boolean)
        .join("\n\n"),
      outputMaxBytes,
    );

    const payload: JsonObject = {
      assistantAttempt,
      messageIndex: Math.max(1, messageIndex),
      content: bounded.text,
      contentTruncated: bounded.truncated,
      stopReason:
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SDK stop reasons are an open provider string.
        typeof message.stopReason === "string" ? message.stopReason : undefined,
      // Tokens and cost of this provider call, for the composer's context meter.
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        cost: message.usage.cost.total,
      },
    };

    if (reasoning.text) {
      payload.reasoning = reasoning.text;
      payload.reasoningTruncated = reasoning.truncated;
    }

    queueEvent(
      "assistant.message",
      `${eventIdentity}:assistant:${assistantAttempt}:${Math.max(1, messageIndex)}:message`,
      payload,
    );
  };

  const onThinkingDelta = (contentIndex: number, delta: string): void => {
    const separator =
      reasoningContentIndex !== undefined && reasoningContentIndex !== contentIndex ? "\n\n" : "";

    reasoningContentIndex = contentIndex;
    bufferDelta("assistant.reasoning.delta", separator + delta);
  };

  const onToolStart = ({
    toolCallId,
    toolName,
    args,
  }: SessionEventOf<"tool_execution_start">): void => {
    queueEvent("tool.started", `${eventIdentity}:tool:${toolCallId}:started`, {
      toolCallId,
      name: toolName,
      args: jsonValueSchema.parse(
        Match.value(toolName).pipe(
          Match.when("edit", () => boundedEditArgs(args)),
          Match.when("write", () => boundedWriteArgs(args)),
          Match.orElse(() => args),
        ),
      ),
    });
  };

  const onToolUpdate = ({
    toolCallId,
    partialResult,
  }: SessionEventOf<"tool_execution_update">): void => {
    const partial = boundedValue(partialResult, outputMaxBytes);
    const outputIndex = toolOutputIndex++;
    queueEvent(
      "tool.output",
      `${eventIdentity}:tool:${toolCallId}:partial:${outputIndex}:${fingerprint(partial.text)}`,
      {
        toolCallId,
        output: partial.text,
        diagnostic: partial.text,
        outputTruncated: partial.truncated,
        truncated: partial.truncated,
        partial: true,
      },
    );
  };

  const onToolEnd = ({
    toolCallId,
    toolName,
    result,
    isError,
  }: SessionEventOf<"tool_execution_end">): void => {
    const outcome = toolOutcomes.get(toolCallId);
    const fallback = boundedValue(result, outputMaxBytes);
    const structured = structuredToolResult(toolName, result);

    queueEvent("tool.completed", `${eventIdentity}:tool:${toolCallId}:completed`, {
      toolCallId,
      name: toolName,
      isError,
      result: structured ?? undefined,
      ...(outcome
        ? commandPayload(outcome)
        : {
            kind: isError ? "unknown" : "completed",
            stdout: "",
            stderr: "",
            output: isError ? publicFailureMessage(fallback.text) : fallback.text,
            diagnostic: isError ? publicFailureMessage(fallback.text) : fallback.text,
            statusCode: null,
            outputTruncated: fallback.truncated,
          }),
    });
  };

  const isDeltaEvent = (event: AgentSessionEvent): boolean =>
    event.type === "message_update" &&
    (event.assistantMessageEvent.type === "text_delta" ||
      event.assistantMessageEvent.type === "thinking_delta");

  return {
    /** Records one SDK event. Text before a non-text event is flushed first to keep order. */
    handle(event: AgentSessionEvent): void {
      if (!isDeltaEvent(event)) flushDelta();

      switch (event.type) {
        case "agent_start":
          assistantAttempt += 1;
          messageIndex = 0;
          break;
        case "message_start":
          if (event.message.role === "assistant") onMessageStart();
          break;
        case "message_end":
          if (event.message.role === "assistant") onMessageEnd(event.message);
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta")
            bufferDelta("assistant.delta", event.assistantMessageEvent.delta);
          else if (event.assistantMessageEvent.type === "thinking_delta")
            onThinkingDelta(
              event.assistantMessageEvent.contentIndex,
              event.assistantMessageEvent.delta,
            );
          break;
        case "tool_execution_start":
          onToolStart(event);
          break;
        case "tool_execution_update":
          onToolUpdate(event);
          break;
        case "tool_execution_end":
          onToolEnd(event);
          break;
        default:
          break;
      }
    },
    flushDelta,
    /** The current turn identity, for checkpoint metadata. */
    assistantAttempt: (): number => assistantAttempt,
    /** Output events of one attempt share one counter across live, partial and final writes. */
    nextToolOutputIndex: (): number => toolOutputIndex++,
  };
}
