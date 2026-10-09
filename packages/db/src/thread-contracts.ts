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

/**
 * The Modal sandbox that read-only reads and previews may reach: running and
 * not mid-transition. Anything else is paused, starting, or gone.
 */
export function reachableSandbox(
  workspace: WorkspaceRecord | null,
): { providerId: string; generation: number } | null {
  if (
    workspace?.state !== "running" ||
    workspace.lifecycleTransitionId ||
    workspace.provider !== "modal" ||
    !workspace.providerId
  )
    return null;

  return { providerId: workspace.providerId, generation: workspace.generation };
}

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
  createdAt: Date;
  updatedAt: Date;
  messages: Array<{
    id: string;
    runId: string | null;
    role: "user" | "assistant" | "system";
    steered?: boolean;
    content: string;
    clientMessageId: string | null;
    createdAt: Date;
    attachments: AttachmentMetadata[];
  }>;
  pendingMessages?: Array<{
    id: string;
    clientMessageId: string | null;
    content: string;
    mode: "steer" | "queue";
    modelSelection: import("./model-contracts").ModelSelection;
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

export type ThreadSummary = Pick<
  ThreadView,
  "id" | "title" | "repositoryUrl" | "repositoryBranch"
> & {
  createdAt: Date;
  updatedAt: Date;
  runStatus: RunStatus | null;
  workspaceState: WorkspaceState | null;
  /** Latest `diff.updated` count, or null before one or after a workspace reset. */
  diffStat: import("./workspace-review").WorkspaceDiffStat | null;
  pullRequest?: import("./git-contracts").ThreadPr | null;
};

export type ThreadListInput = {
  userId: string;
  limit?: number;
  before?: { updatedAt: Date; id: string };
};

export type SubmitResult = {
  threadId: string;
  runId: string;
  messageId?: string;
  delivery?: "pending" | "run";
};

export type ExecutionOwnership = {
  attemptId: string;
  token: string;
  generation: number;
};

export type SubmitInput = {
  manualGit?: import("./manual-git").ManualGitRequest;
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
  mode?: "steer" | "queue";
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
  updatePendingMessage(input: {
    userId: string;
    threadId: string;
    messageId: string;
    prompt: string | null;
  }): Promise<void>;
  pendingSteers(input: {
    runId: string;
    ownershipToken: string;
  }): Promise<Array<{ id: string; content: string }>>;
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
  readRepository(input: { userId: string; threadId: string }): Promise<{
    repositoryUrl: string | null;
    repositoryBranch: string | null;
    branchSuggestion: string | null;
  }>;
  beginAgentExecution(runId: string, ownershipToken: string): Promise<Date>;
  listThreads(input: ThreadListInput): Promise<ThreadSummary[]>;
  getThread(input: { userId: string; threadId: string }): Promise<ThreadView>;
  startQueuedMessage(input: {
    userId: string;
    threadId: string;
    messageId: string;
  }): Promise<SubmitResult>;
  authorizeThread(input: { userId: string; threadId: string }): Promise<void>;
  readSkills(input: {
    userId: string;
    threadId: string;
  }): Promise<import("./skills").SkillMetadata[] | null>;
  listEvents(input: { threadId: string; after?: number; limit?: number }): Promise<ThreadEvent[]>;
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
  /** Saves the generated title unless renamed, and the branch slug for the first clone. */
  completeTitleGeneration(input: {
    threadId: string;
    userId: string;
    title: string;
    branch: string | null;
  }): Promise<void>;
  /** Sets the title and appends `thread.title.updated`; a pending generated title is then dropped. */
  renameThread(input: { threadId: string; userId: string; title: string }): Promise<void>;
  /** Hides the thread and queues workspace deletion; refuses active runs and unsettled Git writes. */
  deleteThread(input: { threadId: string; userId: string }): Promise<void>;
  /** Removes a deleted thread's rows once its workspace is gone. */
  purgeThread(threadId: string): Promise<void>;
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
    consumedSteers?: Array<{ messageId: string; entryId: string }>;
    compaction?: import("./pi-events").ContextCompactedPayload;
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
  /** Queues a wake while idle or waiting for a browser handoff; other active runs refuse it. */
  requestWorkspaceWake(threadId: string): Promise<"queued" | "not-paused" | "active-run">;
  /** Records review panel activity on a running workspace, which defers the idle pause. */
  touchWorkspaceReview(threadId: string): Promise<void>;
  /** The branch the thread's clone started from, for change counts. */
  readRepositoryBranch(threadId: string): Promise<string | null>;
  /** The thread's preview hostname secret. */
  readPreviewSlug(threadId: string): Promise<string | null>;
  /** The reachable sandbox behind a preview slug, or null while paused, starting, or deleted. */
  resolvePreview(slug: string): Promise<{ threadId: string; providerId: string } | null>;
  /** Who drives the thread's hosted browser. */
  readBrowserOwner(threadId: string): Promise<import("./pi-events").BrowserOwner>;
  /** Takes or returns browser control for the thread's owner. */
  changeBrowserOwner(input: {
    userId: string;
    threadId: string;
    owner: import("./pi-events").BrowserOwner;
  }): Promise<void>;
  /** Appends a debounced edge of agent browser activity. */
  recordBrowserActivity(threadId: string, active: boolean): Promise<void>;
  /**
   * Appends `diff.updated` when the count differs from the latest one. A count
   * read from a replaced filesystem generation is dropped.
   */
  recordDiffStat(input: {
    threadId: string;
    generation: number;
    stat: import("./workspace-review").WorkspaceDiffStat;
  }): Promise<void>;
  /** Milliseconds until one idle period has passed since the latest review read. */
  reviewIdleRemainingMs(threadId: string, idleMs: number): Promise<number>;
  listPendingOutbox(limit?: number): Promise<OutboxRecord[]>;
  markDelivered(id: string): Promise<void>;
  recordFailure(id: string, error: string, retryAt?: Date): Promise<void>;
}
