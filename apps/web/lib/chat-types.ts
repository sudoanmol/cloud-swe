import type { CommandOutcomeKind, StructuredToolResult } from "@cloud-swe/db/tool-events";

import type { PublicAttachmentMetadata, RunStatus } from "@cloud-swe/api/contracts";

/** Assistant text identity. Attempt ids are opaque and never compared. */
export type AssistantMessageIdentity = {
  attemptId: string;
  assistantAttempt: number;
  messageIndex: number;
};

export type ProjectedTextPart = {
  kind: "text";
  key: string;
  identity: AssistantMessageIdentity;
  /** Absent on events produced before per-message boundaries existed. */
  legacy: boolean;
  text: string;
  /** Readable model reasoning streamed before or alongside this message. */
  reasoning?: string;
  state: "streaming" | "final" | "partial";
  truncated: boolean;
  stopReason?: string;
};

export type LegacyCommandResult = {
  kind: CommandOutcomeKind;
  stdout: string;
  stderr: string;
  output: string;
  diagnostic: string | null;
  statusCode: number | null;
  outputTruncated: boolean;
};

export type ProjectedToolPart = {
  kind: "tool";
  key: string;
  toolCallId: string;
  attemptId: string;
  name: string;
  state: "running" | "completed" | "failed";
  args: unknown;
  structured: StructuredToolResult | null;
  legacy: LegacyCommandResult | null;
  /** Live incremental output per stream, replaced by the final result. */
  live: { stdout: string; stderr: string; truncated: boolean };
  /** Next expected byte offset per stream, so duplicate chunks are dropped. */
  nextOffset: { stdout: number; stderr: number };
  finalOutput: string | null;
  diagnostic: string | null;
};

export type ProjectedMarkerPart = {
  kind: "marker";
  questionRequestId?: string;
  key: string;
  text: string;
  tone: "info" | "warning" | "error";
};

export type ProjectionPart = ProjectedTextPart | ProjectedToolPart | ProjectedMarkerPart;

export type ProjectedRun = {
  runId: string;
  status: RunStatus | "unknown";
  statusSequence: number;
  error: string | null;
  attemptId: string | null;
  parts: ProjectionPart[];
};

export type ThreadProjection = {
  threadId: string | null;
  /** Highest applied per-thread event sequence. */
  cursor: number;
  title: string | null;
  titleVersion: number;
  runs: ProjectedRun[];
  workspace: { state: string; generation: number | null } | null;
  workspaceSequence: number;
  /** Thread-level notices (workspace reset, question boundaries). */
  notices: ProjectedMarkerPart[];
  /** Unknown future event names, bounded, kept for an unsupported marker. */
  unsupported: string[];
};

/** Snapshot facts the transcript merge needs. */
export type SnapshotMessage = {
  id: string;
  runId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  clientMessageId: string | null;
  createdAt: string;
  attachments: PublicAttachmentMetadata[];
};

export type SnapshotRun = {
  id: string;
  status: RunStatus;
  prompt: string;
  error: string | null;
  createdAt: string;
};

/** A locally accepted submission that the server has not replayed yet. */
/** Accepted, in flight, or failed ambiguously (the same envelope must be retried). */
export type Delivery = "sent" | "sending" | "uncertain";

export type OptimisticMessage = {
  clientMessageId: string;
  runId: string;
  threadId: string;
  text: string;
  attachments: PublicAttachmentMetadata[];
};

export type TranscriptEntry =
  | {
      kind: "user";
      key: string;
      text: string;
      createdAt: string | null;
      attachments: PublicAttachmentMetadata[];
      delivery: Delivery;
      runId: string | null;
      clientMessageId: string | null;
    }
  | { kind: "assistant"; key: string; part: ProjectedTextPart }
  | { kind: "tool"; key: string; runId: string; part: ProjectedToolPart }
  | ProjectedMarkerPart;
