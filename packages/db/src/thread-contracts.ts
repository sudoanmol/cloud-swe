import type { InferSelectModel } from "drizzle-orm";
import type { agentCheckpoint, outbox, run } from "./schema/threads";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SandboxProviderName = "docker" | "freestyle";
export type RunRecord = InferSelectModel<typeof run>;
export type OutboxRecord = InferSelectModel<typeof outbox>;
export type CheckpointRecord = InferSelectModel<typeof agentCheckpoint>;
export type WorkspaceState = "provisioning" | "running" | "paused" | "deleted" | "failed";
export type ThreadEvent = {
  id: string;
  sequence: number;
  type: string;
  payload: unknown;
  dedupeKey: string;
  createdAt: Date;
};

export class ThreadStoreError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "ThreadStoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type ThreadView = {
  id: string;
  userId: string;
  title: string | null;
  repositoryUrl: string | null;
  repositoryBranch: string | null;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    clientMessageId: string | null;
    createdAt: Date;
  }>;
  runs: Array<{
    id: string;
    status: RunStatus;
    prompt: string;
    cancelRequestedAt: Date | null;
    createdAt: Date;
    completedAt: Date | null;
    error: string | null;
  }>;
  workspace: {
    id: string;
    dockerName: string;
    provider: SandboxProviderName;
    state: WorkspaceState;
    providerId: string | null;
  } | null;
  latestEventId: string | null;
};

export type SubmitResult = { threadId: string; runId: string };
export type SubmitInput = {
  userId: string;
  prompt: string;
  clientMessageId: string;
  repositoryUrl?: string;
  repositoryBranch?: string;
  maxActiveRuns?: number;
};
export type MessageInput = Omit<SubmitInput, "repositoryUrl" | "repositoryBranch"> & {
  threadId: string;
};

export interface ThreadStore {
  submitThread(input: SubmitInput): Promise<SubmitResult>;
  submitMessage(input: MessageInput): Promise<SubmitResult>;
  getThread(input: { userId: string; threadId: string }): Promise<ThreadView>;
  listEvents(input: {
    userId: string;
    threadId: string;
    after?: string;
    limit?: number;
  }): Promise<ThreadEvent[]>;
  requestCancel(input: { userId: string; threadId: string; runId: string }): Promise<void>;
  inspectRun(runId: string): Promise<RunRecord | null>;
  loadRun(runId: string): Promise<RunRecord | null>;
  startRun(runId: string): Promise<void>;
  appendRunEvent(input: {
    runId: string;
    type: string;
    payload: unknown;
    dedupeKey: string;
  }): Promise<ThreadEvent>;
  saveCheckpoint(input: { runId: string; step: number; content: unknown }): Promise<void>;
  loadCheckpoint(input: { runId: string; step: number }): Promise<CheckpointRecord | null>;
  loadLatestCheckpoint(input: { threadId: string; step: number }): Promise<CheckpointRecord | null>;
  completeRun(runId: string, assistantContent?: string): Promise<void>;
  failRun(runId: string, error: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  updateWorkspace(input: {
    threadId: string;
    state: WorkspaceState;
    provider?: SandboxProviderName;
    providerId?: string | null;
  }): Promise<void>;
  readWorkspace(threadId: string): Promise<ThreadView["workspace"]>;
  listPendingOutbox(limit?: number): Promise<OutboxRecord[]>;
  markDelivered(id: string): Promise<void>;
  recordFailure(id: string, error: string, retryAt?: Date): Promise<void>;
}
