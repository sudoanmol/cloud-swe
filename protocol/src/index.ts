/**
 * Path: protocol/src/index.ts
 * Used by: the @cloud-swe/protocol package export; the server and any client, protocol/src/{native,storage,tools}.ts.
 * Purpose: The public API contract: sessions, messages, receipts, snapshots, history, events and error envelopes.
 */

import { z } from 'zod';

import { Approval, PullRequest, InitialRepo, Repo } from './git.ts';

export const SessionId = z.uuid().brand<'SessionId'>();
export const OperationId = z.uuid().brand<'OperationId'>();
export const RunId = z.uuid().brand<'RunId'>();
export const WorkspaceId = z.uuid().brand<'WorkspaceId'>();
export const EntryId = z.string().min(1).max(256).brand<'EntryId'>();
export const ToolCallId = z.string().min(1).max(256).brand<'ToolCallId'>();
export const Timestamp = z.iso.datetime();
export const Cursor = z.string().min(1).max(512).brand<'Cursor'>();

// A Boat environment name from the server's allowlist; never a sandbox ID or credential.
export const EnvironmentName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .brand<'EnvironmentName'>();

export const ApiErrorCode = z.enum([
  'unauthorized',
  'api_not_configured',
  'request_too_large',
  'invalid_request',
  'invalid_cursor',
  'unknown_environment',
  'unknown_model',
  'unsupported_provider',
  'not_found',
  'session_not_found',
  'operation_not_found',
  'approval_not_found',
  'operation_conflict',
  'approval_already_decided',
  'run_not_active',
  'session_busy',
  'compaction_running',
  'session_settling',
  'input_queue_full',
  // MAX_SANDBOXES sandboxes are already running; a new session or a resume has to wait.
  'sandbox_limit_reached',
  'sandbox_not_ready',
  'sandbox_unreachable',
  'sandbox_not_configured',
  'sandbox_creation_unconfirmed',
  // The sandbox service definitively refused to create a sandbox; nothing was created.
  'sandbox_refused',
  'model_unavailable',
  'message_unconfirmed',
  'cancel_unconfirmed',
  'internal_error',
]);

export const ApiError = z.strictObject({
  error: z.strictObject({
    code: ApiErrorCode,
    message: z.string().min(1),
  }),
});

export const Capabilities = z.strictObject({
  submitMessage: z.boolean(),
  steerMessage: z.boolean().default(false),
  queueMessage: z.boolean().default(false),
  cancelRun: z.boolean(),
  tools: z.array(z.string().min(1).max(256)),
  approvals: z.boolean(),
  delegation: z.boolean(),
});

// Shared with the native parsers, so an oversized name never parses natively and then fails here.
export const ToolName = z.string().min(1).max(256);

// Application UUIDs are not Pi's numeric conversation IDs.
export const PiRuntime = z.strictObject({
  kind: z.literal('pi-durable'),
  conversationId: z.string().regex(/^[1-9][0-9]*$/),
});

export const Workspace = z.strictObject({
  id: WorkspaceId,
  provider: z.enum(['docker', 'boat']),
  // `deleted`: the sandbox is gone, its saved disk expired, or Boat failed or cancelled it. It can never run again.
  state: z.enum(['starting', 'running', 'stopped', 'unreachable', 'deleted']),
});

export const RunFailureCode = z.enum([
  'rate_limited',
  'overloaded',
  'context_overflow',
  'auth',
  'billing',
  'internal',
  'unknown',
]);

export type RunFailureCode = z.infer<typeof RunFailureCode>;

export const RunState = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('idle') }),
  z.strictObject({ kind: z.literal('running'), runId: RunId }),
  z.strictObject({ kind: z.literal('cancelling'), runId: RunId }),
  z.strictObject({ kind: z.literal('completed'), runId: RunId }),
  z.strictObject({ kind: z.literal('cancelled'), runId: RunId }),
  // Pi is waiting out a transient provider failure and will try again by itself.
  z.strictObject({
    kind: z.literal('retrying'),
    runId: RunId,
    code: RunFailureCode,
    message: z.string().min(1),
    nextAttemptAt: Timestamp,
  }),
  z.strictObject({ kind: z.literal('failed'), runId: RunId, code: RunFailureCode, message: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('uncertain'),
    runId: RunId,
    operationId: OperationId,
    reason: z.string().min(1),
  }),
]);

export const CompactionReason = z.enum(['manual', 'threshold', 'overflow']);

// Pi's compaction task projected for clients: running now, or (below) the newest failure. Messages are fixed text.
export const CompactionState = z.strictObject({
  reason: CompactionReason,
  blocking: z.boolean(),
  attempt: z.number().int().positive(),
  nextAttemptAt: Timestamp.optional(),
});

export const CompactionFailure = z.strictObject({
  reason: CompactionReason,
  code: RunFailureCode,
  message: z.string().min(1),
});

export const Session = z.strictObject({
  id: SessionId,
  engine: z.literal('pi'),
  target: z.literal('cloud'),
  runtime: PiRuntime,
  model: z.strictObject({ provider: z.string().min(1).max(128), id: z.string().min(1).max(256) }),
  workspace: Workspace,
  capabilities: Capabilities,
  run: RunState,
  compaction: CompactionState.nullable().default(null),
  compactionFailure: CompactionFailure.nullable().default(null),
  pending: z
    .array(
      z.strictObject({
        operationId: OperationId,
        runId: RunId,
        mode: z.enum(['reject', 'steer', 'followUp']),
        status: z.enum(['queued', 'running', 'parked']),
        // What was sent, so every client can show a message before it enters the transcript.
        text: z.string().min(1).max(64_000),
      }),
    )
    .max(100)
    .default([]),
  // Registered repositories; registration is the authorization to fetch them. At most one is the base.
  repos: z.array(Repo).max(50).default([]),
  // Open approvals plus the most recent decided ones.
  approvals: z.array(Approval).max(100).default([]),
  // Pull requests this session opened, last known state.
  pullRequests: z.array(PullRequest).max(100).default([]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const CreateSessionRequest = z.strictObject({
  operationId: OperationId,
  engine: z.literal('pi'),
  target: z.literal('cloud'),
  environment: EnvironmentName,
  repo: InitialRepo.optional(),
  model: Session.shape.model,
});

export const CreateSessionResponse = z.strictObject({ operationId: OperationId, session: Session });
export const SessionParams = z.strictObject({ sessionId: SessionId });
export const OperationParams = SessionParams.extend({ operationId: OperationId });

export const PageQuery = z.strictObject({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ListSessionsResponse = z.strictObject({
  sessions: z.array(Session).max(100),
  // Sessions on this page whose state could not be read right now; a retry may succeed.
  unavailable: z.array(SessionId).max(100),
  nextCursor: Cursor.nullable(),
});

export const SubmitMessageRequest = z.strictObject({
  operationId: OperationId,
  mode: z.enum(['reject', 'steer', 'followUp']).default('reject'),
  text: z
    .string()
    .min(1)
    .max(64_000)
    .refine((text) => text.trim().length > 0, 'Message must not be blank'),
});

export const CancelRunRequest = z.strictObject({ operationId: OperationId, runId: RunId });

// Optional instructions steer what the summary keeps.
export const CompactRequest = z.strictObject({ instructions: z.string().min(1).max(10_000).optional() });

export const OperationReceipt = z.strictObject({
  operationId: OperationId,
  sessionId: SessionId,
  runId: RunId,
  action: z.enum(['submit_message', 'cancel_run']),
  status: z.literal('accepted'),
  acceptedAt: Timestamp,
});

export const CancelRunResponse = OperationReceipt.extend({
  action: z.literal('cancel_run'),
  restoredMessages: z
    .array(
      z.strictObject({
        operationId: OperationId,
        mode: z.enum(['reject', 'steer', 'followUp']),
        text: SubmitMessageRequest.shape.text,
      }),
    )
    .max(100)
    .default([]),
});

export const ContentBlock = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string() }),
  z.strictObject({ kind: z.literal('reasoning'), text: z.string() }),
  z.strictObject({
    kind: z.literal('tool_call'),
    toolCallId: ToolCallId,
    name: ToolName,
    arguments: z.record(z.string(), z.json()),
  }),
]);

export type ContentBlock = z.infer<typeof ContentBlock>;

export const ToolOutcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unavailable'), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('running'), output: z.string().optional() }),
  z.strictObject({ kind: z.literal('succeeded'), output: z.string().nullable() }),
  z.strictObject({ kind: z.literal('failed'), message: z.string().min(1), output: z.string().optional() }),
  z.strictObject({ kind: z.literal('interrupted'), reason: z.string().min(1), output: z.string().optional() }),
  z.strictObject({
    kind: z.literal('uncertain'),
    operationId: OperationId,
    reason: z.string().min(1),
    output: z.string().optional(),
  }),
]);

export const NestedCallSummary = z.strictObject({
  localId: z.number().int().positive(),
  name: z.string().min(1),
  argumentsPreview: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});

export const ToolActivity = z.strictObject({
  toolCallId: ToolCallId,
  parentToolCallId: ToolCallId.nullable().default(null),
  taskId: z.string().min(1).nullable().default(null),
  name: ToolName,
  arguments: z.record(z.string(), z.json()).nullable(),
  outcome: ToolOutcome,
  structuredOutput: z.json().optional(),
  details: z.json().optional(),
  nestedCalls: z.array(NestedCallSummary).default([]),
});

export type ToolActivity = z.infer<typeof ToolActivity>;

const entryFields = { id: EntryId, createdAt: Timestamp, native: z.json().optional() };

export const Entry = z.discriminatedUnion('kind', [
  z.strictObject({ ...entryFields, kind: z.literal('native'), nativeKind: z.string().min(1), payload: z.json() }),
  z.strictObject({
    ...entryFields,
    kind: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    content: z.array(ContentBlock).min(1),
    status: z.enum(['streaming', 'committed', 'interrupted']),
  }),
  z.strictObject({
    ...entryFields,
    kind: z.literal('tool'),
    ...ToolActivity.shape,
  }),
]);

export const HistoryResponse = z.strictObject({ entries: z.array(Entry).max(100), nextCursor: Cursor.nullable() });

export const Snapshot = z.strictObject({
  session: Session,
  history: HistoryResponse,
  tools: z.array(ToolActivity).max(100).default([]),
  toolsTruncated: z.boolean().default(false),
});

// Every event replaces the client's live projection; there is no durable token replay promise.
export const SessionEvent = z.strictObject({ kind: z.literal('snapshot'), snapshot: Snapshot });

// Internal reconciliation record, not a public shell-execution endpoint.
export const CommandIdentity = z.strictObject({ workspaceId: WorkspaceId, operationId: OperationId });

const commandOutput = { output: z.string().max(8192), outputBytes: z.number().int().nonnegative() };

// Only open commands can be cancelled or watched for liveness; terminal variants cannot represent either.
const openCommand = {
  identity: CommandIdentity,
  cancelRequested: z.boolean(),
  heartbeat: z.int().nonnegative(),
  lastSeenAt: z.number().nonnegative(),
  ...commandOutput,
};

export const OpenCommandRecord = z.discriminatedUnion('kind', [
  z.strictObject({ ...openCommand, kind: z.literal('prepared') }),
  z.strictObject({ ...openCommand, kind: z.literal('running') }),
  z.strictObject({ ...openCommand, kind: z.literal('uncertain'), reason: z.string().min(1) }),
]);

export const CommandRecord = z.discriminatedUnion('kind', [
  ...OpenCommandRecord.options,
  z.strictObject({ kind: z.literal('not_started'), identity: CommandIdentity, reason: z.string().min(1) }),
  z.strictObject({
    ...commandOutput,
    kind: z.literal('exited'),
    identity: CommandIdentity,
    exitCode: z.int(),
    termination: z.enum(['exit', 'cancelled', 'timeout']),
  }),
  // The supervisor is gone or never ran. A cancel marker stops a late start, but work it began may have happened.
  z.strictObject({ ...commandOutput, kind: z.literal('lost'), identity: CommandIdentity, reason: z.string().min(1) }),
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export type ApiError = z.infer<typeof ApiError>;

export type Session = z.infer<typeof Session>;

export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export type SubmitMessageRequest = z.infer<typeof SubmitMessageRequest>;

export type CancelRunRequest = z.infer<typeof CancelRunRequest>;

export type CompactRequest = z.infer<typeof CompactRequest>;

export type OperationReceipt = z.infer<typeof OperationReceipt>;

export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

export type PageQuery = z.infer<typeof PageQuery>;

export type Snapshot = z.infer<typeof Snapshot>;

export type SessionEvent = z.infer<typeof SessionEvent>;

export type Entry = z.infer<typeof Entry>;

export type CommandRecord = z.infer<typeof CommandRecord>;
