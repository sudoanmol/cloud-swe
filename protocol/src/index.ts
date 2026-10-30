import { z } from 'zod';

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

export const ApiError = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'unauthorized',
      'not_found',
      'invalid_request',
      'operation_conflict',
      'run_conflict',
      'busy',
      'unavailable',
      'internal_error',
    ]),
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

// Application UUIDs are not Pi's numeric conversation IDs.
export const PiRuntime = z.strictObject({
  kind: z.literal('pi-durable'),
  conversationId: z.string().regex(/^[1-9][0-9]*$/),
});

export const Workspace = z.strictObject({
  id: WorkspaceId,
  provider: z.enum(['docker', 'boat']),
  state: z.enum(['starting', 'running', 'stopped', 'unreachable', 'error']),
});

export const RunState = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('idle') }),
  z.strictObject({ kind: z.literal('running'), runId: RunId }),
  z.strictObject({ kind: z.literal('cancelling'), runId: RunId }),
  z.strictObject({ kind: z.literal('completed'), runId: RunId }),
  z.strictObject({ kind: z.literal('cancelled'), runId: RunId }),
  z.strictObject({ kind: z.literal('interrupted'), runId: RunId, reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal('failed'), runId: RunId, message: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('uncertain'),
    runId: RunId,
    operationId: OperationId,
    reason: z.string().min(1),
  }),
]);

export const Session = z.strictObject({
  id: SessionId,
  engine: z.literal('pi'),
  target: z.literal('cloud'),
  runtime: PiRuntime,
  model: z.strictObject({ provider: z.string().min(1).max(128), id: z.string().min(1).max(256) }),
  workspace: Workspace,
  capabilities: Capabilities,
  run: RunState,
  pending: z
    .array(
      z.strictObject({
        operationId: OperationId,
        runId: RunId,
        mode: z.enum(['reject', 'steer', 'followUp']),
        status: z.enum(['queued', 'running', 'parked']),
      }),
    )
    .max(100)
    .default([]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const CreateSessionRequest = z.strictObject({
  operationId: OperationId,
  engine: z.literal('pi'),
  target: z.literal('cloud'),
  environment: EnvironmentName,
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
    name: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.json()),
  }),
]);

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
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.json()).nullable(),
  outcome: ToolOutcome,
  structuredOutput: z.json().optional(),
  details: z.json().optional(),
  nestedCalls: z.array(NestedCallSummary).default([]),
});

export type ToolActivity = z.infer<typeof ToolActivity>;

const entryFields = { id: EntryId, runId: RunId.nullable(), createdAt: Timestamp, native: z.json().optional() };

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
  native: z.json().optional(),
});

// Each connection starts with a replacement snapshot; there is no durable token replay promise.
export const SessionEvent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('snapshot'), snapshot: Snapshot }),
  z.strictObject({ kind: z.literal('session.updated'), session: Session }),
  z.strictObject({ kind: z.literal('entry.upserted'), sessionId: SessionId, entry: Entry }),
  z.strictObject({ kind: z.literal('operation.accepted'), receipt: OperationReceipt }),
]);

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

export type ApiError = z.infer<typeof ApiError>;

export type Session = z.infer<typeof Session>;

export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export type SubmitMessageRequest = z.infer<typeof SubmitMessageRequest>;

export type CancelRunRequest = z.infer<typeof CancelRunRequest>;

export type OperationReceipt = z.infer<typeof OperationReceipt>;

export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

export type PageQuery = z.infer<typeof PageQuery>;

export type Snapshot = z.infer<typeof Snapshot>;

export type SessionEvent = z.infer<typeof SessionEvent>;

export type Entry = z.infer<typeof Entry>;

export type CommandRecord = z.infer<typeof CommandRecord>;
