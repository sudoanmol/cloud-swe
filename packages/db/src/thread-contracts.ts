import type { InferSelectModel } from "drizzle-orm";
import type {
  agentCheckpoint,
  commandOperation,
  outbox,
  run,
  threadEvent,
  workspace,
} from "./schema/threads";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SandboxProviderName = "docker" | "freestyle";
export type WorkspaceState =
  | "provisioning"
  | "running"
  | "paused"
  | "deleted"
  | "failed"
  | "quarantined"
  | "recovery";
export type CommandOperationState = "pending" | "running" | "completed" | "failed" | "unknown";
/** Named checkpoint keys replace the old mode-dependent integer namespace. */
export type CheckpointKey = string;

export type RunRecord = InferSelectModel<typeof run>;
export type OutboxRecord = InferSelectModel<typeof outbox>;
export type CheckpointRecord = InferSelectModel<typeof agentCheckpoint>;
export type WorkspaceRecord = InferSelectModel<typeof workspace>;
export type CommandOperationRecord = InferSelectModel<typeof commandOperation>;
export type ThreadEventRecord = InferSelectModel<typeof threadEvent>;

/** The stable identity and current filesystem generation passed to providers. */
export type WorkspaceRef = Pick<
  WorkspaceRecord,
  "id" | "threadId" | "name" | "provider" | "providerId" | "generation"
>;

export type ThreadEvent = Pick<
  ThreadEventRecord,
  "id" | "sequence" | "type" | "payload" | "dedupeKey" | "createdAt"
>;

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
  workspace: WorkspaceRecord | null;
  latestEventId: number | null;
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

export type CommandBeginInput = {
  commandId?: string;
  workspaceId: string;
  generation: number;
  runId: string;
  attemptId: string;
  metadata: unknown;
};

export type CommandUpdateInput = {
  commandId: string;
  state?: CommandOperationState;
  cancellationRequested?: boolean;
  metadata?: unknown;
  result?: unknown;
};

export type CleanupProviderResult =
  | { outcome: "completed"; providerId?: string | null }
  | { outcome: "missing"; providerId?: null }
  | { outcome: "unknown"; providerId?: string | null };

export type CleanupDeferredReason = "active-run" | "unsettled-command";
export type CleanupResult =
  | {
      outcome: "deferred";
      reason: CleanupDeferredReason;
      transitionId: string;
      workspace: WorkspaceRecord;
    }
  | {
      outcome: "completed" | "missing" | "unknown";
      transitionId: string;
      workspace: WorkspaceRecord;
    };

export interface ThreadStore {
  submitThread(input: SubmitInput): Promise<SubmitResult>;
  submitMessage(input: MessageInput): Promise<SubmitResult>;
  getThread(input: { userId: string; threadId: string }): Promise<ThreadView>;
  authorizeThread(input: { userId: string; threadId: string }): Promise<void>;
  listEvents(input: { threadId: string; after?: number; limit?: number }): Promise<ThreadEvent[]>;
  requestCancel(input: { userId: string; threadId: string; runId: string }): Promise<void>;
  loadRun(runId: string): Promise<RunRecord | null>;
  startRun(runId: string): Promise<void>;
  appendRunEvent(input: {
    runId: string;
    type: string;
    payload: unknown;
    dedupeKey: string;
  }): Promise<ThreadEvent>;
  saveCheckpoint(input: {
    runId: string;
    key: CheckpointKey;
    content: unknown;
    generation: number;
    attemptId: string;
  }): Promise<void>;
  loadCheckpoint(input: {
    runId: string;
    key: CheckpointKey | string;
    generation?: number;
  }): Promise<CheckpointRecord | null>;
  loadLatestCheckpoint(input: {
    threadId: string;
    key: CheckpointKey | string;
    generation?: number;
  }): Promise<CheckpointRecord | null>;
  completeRun(runId: string, assistantContent?: string): Promise<void>;
  failRun(runId: string, error: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  updateWorkspace(input: {
    threadId: string;
    state: WorkspaceState;
    provider?: SandboxProviderName;
    providerId?: string | null;
    name?: string;
    generation?: number;
    lifecycleTransitionId?: string;
  }): Promise<WorkspaceRecord>;
  readWorkspace(threadId: string): Promise<WorkspaceRecord | null>;
  persistRecoveredProviderId(input: {
    workspaceId: string;
    providerId: string;
  }): Promise<WorkspaceRecord>;
  resetWorkspace(input: {
    threadId: string;
    expectedGeneration: number;
    /** The provider has confirmed the old filesystem is missing; reset is fail-closed otherwise. */
    confirmedMissing: boolean;
    reason: string;
    transitionId?: string;
    providerId?: string | null;
    state?: "provisioning" | "recovery" | "quarantined";
  }): Promise<{
    workspace: WorkspaceRecord;
    oldGeneration: number;
    newGeneration: number;
    event: ThreadEvent;
    alreadyApplied: boolean;
  }>;
  beginLifecycleTransition(input: {
    threadId: string;
    transitionId?: string;
    state: WorkspaceState;
  }): Promise<{ transitionId: string; workspace: WorkspaceRecord }>;
  cancelLifecycleTransition(input: {
    threadId: string;
    transitionId: string;
  }): Promise<WorkspaceRecord>;
  cleanupWorkspace(input: {
    threadId: string;
    transitionId?: string;
    targetState: "paused" | "deleted";
    mutate: (workspace: WorkspaceRecord) => Promise<CleanupProviderResult>;
  }): Promise<CleanupResult>;
  beginCommand(input: CommandBeginInput): Promise<CommandOperationRecord>;
  readCommand(commandId: string): Promise<CommandOperationRecord | null>;
  listUnsettledCommands(input: {
    workspaceId: string;
    generation?: number;
  }): Promise<CommandOperationRecord[]>;
  updateCommand(input: CommandUpdateInput): Promise<CommandOperationRecord>;
  listPendingOutbox(limit?: number): Promise<OutboxRecord[]>;
  markDelivered(id: string): Promise<void>;
  recordFailure(id: string, error: string, retryAt?: Date): Promise<void>;
}
