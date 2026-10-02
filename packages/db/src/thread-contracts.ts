import type { InferSelectModel } from "drizzle-orm";
import type { JsonObject } from "./json";
import type {
  agentCheckpoint,
  attachment,
  commandOperation,
  outbox,
  run,
  threadEvent,
  workspace,
} from "./schema/threads";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type SandboxProviderName = "docker" | "modal";

export type WorkspaceState =
  | "provisioning"
  | "running"
  | "paused"
  | "deleted"
  | "failed"
  | "quarantined"
  | "recovery";

export type CommandOperationState =
  | "queued"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "unknown";
/** Named checkpoint keys replace the old mode-dependent integer namespace. */

export type RunRecord = InferSelectModel<typeof run>;

export type OutboxRecord = InferSelectModel<typeof outbox>;

export type CheckpointRecord = InferSelectModel<typeof agentCheckpoint>;

export type AttachmentRecord = InferSelectModel<typeof attachment>;

export type AttachmentMetadata = Pick<
  AttachmentRecord,
  | "id"
  | "filename"
  | "detectedMimeType"
  | "classification"
  | "modelMimeType"
  | "modelSize"
  | "modelWidth"
  | "modelHeight"
> & { size: number | null };

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

export type EventIndexRow = {
  sequence: number;
  type: string;
  runId: unknown;
  attemptId: unknown;
  assistantAttempt: unknown;
  messageIndex: unknown;
  contentTruncated: unknown;
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
  createdAt: Date;
  updatedAt: Date;
  messages: Array<{
    id: string;
    runId: string | null;
    role: "user" | "assistant" | "system";
    content: string;
    clientMessageId: string | null;
    createdAt: Date;
    attachments: AttachmentMetadata[];
  }>;
  runs: PublicRun[];
  workspace: PublicWorkspace | null;
  latestEventId: number | null;
};

/** Public run projection. Execution ownership tokens and access policy stay internal. */
export type PublicRun = {
  id: string;
  status: RunStatus;
  prompt: string;
  modelSelection: import("./model-contracts").ModelSelection | null;
  cancelRequestedAt: Date | null;
  approvalWaitStartedAt: Date | null;
  questionWaitStartedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  error: string | null;
};

/** Public workspace projection. Provider IDs and lifecycle transition IDs stay internal. */
export type PublicWorkspace = {
  id: string;
  state: WorkspaceState;
  provider: SandboxProviderName;
  generation: number;
  updatedAt: Date;
};

export type ThreadSummary = Pick<ThreadView, "id" | "title"> & {
  createdAt: Date;
  updatedAt: Date;
  runStatus: RunStatus | null;
  workspaceState: WorkspaceState | null;
};

export type ThreadListInput = {
  userId: string;
  limit?: number;
  before?: { createdAt: Date; id: string };
};

export type SubmitResult = { threadId: string; runId: string };

export type ExecutionOwnership = {
  attemptId: string;
  token: string;
  generation: number;
};

export type SubmitInput = {
  modelSelection?: import("./model-selection").ModelSelection;
  userId: string;
  prompt: string;
  clientMessageId: string;
  repositoryUrl?: string;
  repositoryBranch?: string;
  maxActiveRuns?: number;
  attachmentIds?: string[];
};

export type MessageInput = Omit<SubmitInput, "repositoryUrl" | "repositoryBranch"> & {
  threadId: string;
};

export type CommandBeginInput = {
  ownershipToken: string;
  access?: "read" | "exclusive";
  queued?: boolean;
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

export const WORKSPACE_RESET_INSTRUCTION =
  "The workspace filesystem was replaced. Uncommitted files and local, unpushed commits may be gone. Inspect /workspace before continuing.";

export interface ThreadStore {
  submitThread(input: SubmitInput): Promise<SubmitResult>;
  submitMessage(input: MessageInput): Promise<SubmitResult>;
  reserveAttachment(input: {
    userId: string;
    filename: string;
    classification: "image" | "file";
    detectedMimeType: string;
  }): Promise<AttachmentRecord>;
  completeAttachment(input: {
    id: string;
    userId: string;
    originalSha256: string;
    originalSize: number;
    modelSha256?: string;
    modelMimeType?: string;
    modelSize?: number;
    modelWidth?: number;
    modelHeight?: number;
  }): Promise<AttachmentRecord>;
  failAttachment(input: { id: string; userId: string }): Promise<void>;
  readOwnedAttachment(input: { id: string; userId: string }): Promise<AttachmentRecord>;
  beginDeleteAttachment(input: { id: string; userId: string }): Promise<AttachmentRecord>;
  finishDeleteAttachment(id: string): Promise<void>;
  claimExpiredAttachments(before: Date, limit?: number): Promise<AttachmentRecord[]>;
  attachmentsForRun(runId: string): Promise<AttachmentRecord[]>;
  listThreadAttachments(threadId: string): Promise<AttachmentRecord[]>;
  readRepository(input: {
    userId: string;
    threadId: string;
  }): Promise<{ repositoryUrl: string | null; repositoryBranch: string | null }>;
  isOwner(userId: string): Promise<boolean>;
  threadIsOwner(threadId: string): Promise<boolean>;
  beginAgentExecution(runId: string, ownershipToken: string): Promise<Date>;
  listThreads(input: ThreadListInput): Promise<ThreadSummary[]>;
  getThread(input: { userId: string; threadId: string }): Promise<ThreadView>;
  /** Checks ownership and returns the committed event watermark. */
  authorizeThread(input: { userId: string; threadId: string }): Promise<{ eventSequence: number }>;
  listEvents(input: { threadId: string; after?: number; limit?: number }): Promise<ThreadEvent[]>;
  /** Identity columns only, for replay planning; never the event bodies. */
  listEventIndex(input: {
    threadId: string;
    after: number;
    through: number;
    limit: number;
  }): Promise<EventIndexRow[]>;
  listEventsAt(input: { threadId: string; sequences: readonly number[] }): Promise<ThreadEvent[]>;
  requestCancel(input: { userId: string; threadId: string; runId: string }): Promise<void>;
  readQuestionRequest(id: string): Promise<import("./question-contracts").QuestionRequest>;
  listQuestionRequests(input: {
    userId: string;
    threadId: string;
  }): Promise<import("./question-contracts").QuestionRequest[]>;
  pendingQuestionRequest(
    runId: string,
  ): Promise<import("./question-contracts").QuestionRequest | null>;
  answerQuestionRequest(input: {
    userId: string;
    threadId: string;
    requestId: string;
    answers: import("./question-contracts").QuestionAnswers;
  }): Promise<import("./question-contracts").QuestionRequest>;
  resumeQuestionWait(runId: string): Promise<void>;
  /** At-most-once claim for best-effort title generation. Commits before dispatch. */
  claimTitleGeneration(input: {
    threadId: string;
    userId: string;
  }): Promise<{ claimed: boolean; prompt: string | null }>;
  completeTitleGeneration(input: {
    threadId: string;
    userId: string;
    title: string;
  }): Promise<void>;
  loadRun(runId: string): Promise<RunRecord | null>;
  startRun(runId: string): Promise<void>;
  claimExecutionOwnership(input: {
    runId: string;
    attemptId: string;
    generation: number;
  }): Promise<ExecutionOwnership>;
  appendRunEvent(input: {
    runId: string;
    ownershipToken: string;
    type: string;
    payload: JsonObject;
    dedupeKey: string;
  }): Promise<ThreadEvent>;
  saveCheckpoint(input: {
    gitProposal?: import("./git-contracts").GitProposal;
    questionRequest?: import("./question-contracts").QuestionRequestPayload;
    runId: string;
    key: string;
    content: unknown;
    generation: number;
    attemptId: string;
    ownershipToken: string;
  }): Promise<void>;
  loadCheckpoint(input: {
    runId: string;
    key: string;
    generation?: number;
  }): Promise<CheckpointRecord | null>;
  loadLatestCheckpoint(input: {
    threadId: string;
    key: string;
    generation?: number;
  }): Promise<CheckpointRecord | null>;
  completeRun(
    runId: string,
    assistantContent: string | undefined,
    ownershipToken: string,
  ): Promise<void>;
  failRun(runId: string, error: string, failureCode?: string): Promise<void>;
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
    waitingRunId?: string;
    mutate: (workspace: WorkspaceRecord) => Promise<CleanupProviderResult>;
  }): Promise<CleanupResult>;
  beginCommand(input: CommandBeginInput): Promise<CommandOperationRecord>;
  admitCommand(commandId: string): Promise<CommandOperationRecord | null>;
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
