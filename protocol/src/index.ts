/**
 * Path: protocol/src/index.ts
 * Used by: the @cloud-swe/protocol package export; the server and any client, protocol/src/{native,storage,tools}.ts.
 * Purpose: The public API contract: sessions, the session list, messages, receipts, snapshots, events and error envelopes.
 */

/*
 * Tolerance: an older client must read a newer server. Every enum and tagged union in a response is open: a newer
 * server may add a value or a variant, and a client keeps an unknown enum value as its raw string and decodes an
 * unknown variant as unknown. A response field is only ever added, never renamed, retyped or removed, without a
 * protocol change. Request enums are closed: the server rejects a value it does not know.
 */

import { z } from 'zod';

import { MessageAttachments } from './attachments.ts';
import { EnvironmentName, SecretRequest } from './environments.ts';
import { Approval, PullRequest, InitialRepo, Repo } from './git.ts';
import { Question, Todo, TODO_LIMITS } from './interaction.ts';
import {
  ConversationId,
  Cursor,
  EntryId,
  OperationId,
  RunId,
  SessionId,
  Timestamp,
  WorkspaceId,
} from './primitives.ts';
import { Entry, HISTORY_PAGE_LIMIT, HistoryResponse, LiveState } from './transcript.ts';

export * from './primitives.ts';

export * from './transcript.ts';

// A sandbox template from the server's allowlist (an E2B template name); never a sandbox ID or credential.
export const TemplateName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .brand<'TemplateName'>();

export const ApiErrorCode = z.enum([
  'unauthorized',
  'api_not_configured',
  'request_too_large',
  'invalid_request',
  'invalid_cursor',
  'unknown_template',
  'unknown_environment',
  'environment_not_found',
  // ENVIRONMENT_LIMITS: too many environments, variables or network secrets.
  'environment_limit',
  // One name can't be both a variable and a network secret in an environment.
  'secret_name_conflict',
  'invalid_host',
  // The agent's environment tool on a session created without an environment.
  'no_environment',
  'unknown_model',
  'unsupported_provider',
  'not_found',
  'session_not_found',
  'operation_not_found',
  'approval_not_found',
  'question_not_found',
  'secret_request_not_found',
  'conversation_not_found',
  // A message, cancel or compaction sent to a conversation the session has moved off.
  'conversation_not_active',
  'attachment_not_found',
  // Over ATTACHMENT_LIMITS.bytes.
  'attachment_too_large',
  // Not one of ImageMediaType.
  'attachment_type_unsupported',
  // The app's sign-in code is unknown, used, expired, or its verifier doesn't match. One code, so none is told apart.
  'invalid_sign_in_code',
  // The login route was given a redirect other than APP_REDIRECT_URI.
  'invalid_redirect',
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

export const Workspace = z.strictObject({
  id: WorkspaceId,
  // `deleted`: the sandbox is gone and can never run again.
  state: z.enum(['starting', 'running', 'stopped', 'unreachable', 'deleted']),
});

export const RunFailureCode = z.enum([
  'rate_limited',
  'overloaded',
  'context_overflow',
  'auth',
  'billing',
  // The provider's policy check blocked the request. The message stays in the conversation, so a retry may be blocked too.
  'refused',
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

const CompactionReason = z.enum(['manual', 'threshold', 'overflow']);

// Pi's compaction task projected for clients: running now, or (below) the newest failure. Messages are fixed text.
const CompactionState = z.strictObject({
  reason: CompactionReason,
  blocking: z.boolean(),
  attempt: z.number().int().positive(),
  nextAttemptAt: Timestamp.optional(),
});

const CompactionFailure = z.strictObject({
  reason: CompactionReason,
  code: RunFailureCode,
  message: z.string().min(1),
});

const MessageMode = z.enum(['reject', 'steer', 'followUp']);

const MessageText = z.string().min(1).max(64_000);

// Inputs a session holds waiting for the model; a message past this is refused.
export const PENDING_INPUTS_LIMIT = 100;

// Approvals, questions and secret requests a session lists: the open ones plus the newest decided ones.
export const FOLLOW_UP_LIMIT = 100;

// A session title is at most this many characters.
export const SESSION_TITLE_LIMIT = 80;

const SessionTitle = z.string().trim().min(1).max(SESSION_TITLE_LIMIT);

/** The title a session gets from its first user message: the first line, trimmed and cut to the limit. */
export const sessionTitle = (text: string) =>
  (text.trim().split('\n')[0] ?? '').trim().slice(0, SESSION_TITLE_LIMIT).trimEnd();

// Spend as Pi records it on each model response and tool result, summed over every conversation in the session. Cost
// is US dollars at the model catalog's price: an estimate of the bill, not the bill.
export const SessionUsage = z.strictObject({
  input: z.int().nonnegative(),
  output: z.int().nonnegative(),
  cacheRead: z.int().nonnegative(),
  cacheWrite: z.int().nonnegative(),
  totalTokens: z.int().nonnegative(),
  cost: z.strictObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
});

export type SessionUsage = z.infer<typeof SessionUsage>;

// `run`, `compaction`, `compactionFailure`, `pending` and `todos` describe the active conversation.
export const Session = z.strictObject({
  id: SessionId,
  // Null until the first user message; then that message's first line, until a rename.
  title: SessionTitle.nullable(),
  // The conversation messages go to. When it changes, a client moves to the new conversation's routes and stream.
  activeConversationId: ConversationId,
  model: z.strictObject({ provider: z.string().min(1).max(128), id: z.string().min(1).max(256) }),
  workspace: Workspace,
  // The account environment whose secrets the sandbox gets; null is the empty default.
  environment: EnvironmentName.nullable().default(null),
  run: RunState,
  compaction: CompactionState.nullable().default(null),
  compactionFailure: CompactionFailure.nullable().default(null),
  pending: z
    .array(
      z.strictObject({
        operationId: OperationId,
        runId: RunId,
        mode: MessageMode,
        status: z.enum(['queued', 'running', 'parked']),
        // What was sent, so every client can show a message before it enters the transcript.
        text: MessageText,
        attachments: MessageAttachments.default([]),
      }),
    )
    .max(PENDING_INPUTS_LIMIT)
    .default([]),
  // Registered repositories; registration is the authorization to fetch them. At most one is the base.
  repos: z.array(Repo).max(50).default([]),
  // Open approvals plus the most recent decided ones.
  approvals: z.array(Approval).max(FOLLOW_UP_LIMIT).default([]),
  // Pull requests this session opened, last known state.
  pullRequests: z.array(PullRequest).max(100).default([]),
  // Open questions to the user plus the most recent answered ones.
  questions: z.array(Question).max(FOLLOW_UP_LIMIT).default([]),
  // Open requests for network secrets plus the most recent decided ones. Never a value.
  secretRequests: z.array(SecretRequest).max(FOLLOW_UP_LIMIT).default([]),
  // The agent's task list, as of the conversation's current point.
  todos: z.array(Todo).max(TODO_LIMITS.tasks).default([]),
  usage: SessionUsage,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

// Without a template the server uses the first one it allows, and without a model its configured one.
export const CreateSessionRequest = z.strictObject({
  operationId: OperationId,
  template: TemplateName.optional(),
  environment: EnvironmentName.optional(),
  repo: InitialRepo.optional(),
  model: Session.shape.model.optional(),
});

export const RenameSessionRequest = z.strictObject({ title: SessionTitle });

export const CreateSessionResponse = z.strictObject({ operationId: OperationId, session: Session });
export const SessionParams = z.strictObject({ sessionId: SessionId });
export const OperationParams = SessionParams.extend({ operationId: OperationId });

// /v1/sessions/:sessionId/conversations/:conversationId/{messages,cancel,compact,snapshot,events,history}.
export const ConversationParams = SessionParams.extend({ conversationId: ConversationId });

export const PageQuery = z.strictObject({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// A list row's preview is at most this many characters.
export const SESSION_PREVIEW_LIMIT = 200;

/** A row of the session list: enough to draw it and to open the session's active conversation without another call. */
export const SessionSummary = z.strictObject({
  id: SessionId,
  title: SessionTitle.nullable(),
  // The start of the newest message's text; null before the first message.
  preview: z.string().min(1).max(SESSION_PREVIEW_LIMIT).nullable(),
  run: RunState,
  // Approvals, questions and secret requests waiting on the user.
  openRequests: z.int().nonnegative(),
  activeConversationId: ConversationId,
  createdAt: Timestamp,
  // The session's `updatedAt`: its newest committed message.
  updatedAt: Timestamp,
});

export type SessionSummary = z.infer<typeof SessionSummary>;

/** The list row for a session, given the preview its transcript yields. */
export function sessionSummary(session: Session, preview: string | null): SessionSummary {
  const requests = [...session.approvals, ...session.questions, ...session.secretRequests];

  return SessionSummary.parse({
    id: session.id,
    title: session.title,
    preview,
    run: session.run,
    openRequests: requests.filter((request) => request.state === 'pending').length,
    activeConversationId: session.activeConversationId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
}

// Newest `updatedAt` first, ties by ID. A page cursor is opaque.
export const ListSessionsResponse = z.strictObject({
  sessions: z.array(SessionSummary).max(100),
  nextCursor: Cursor.nullable(),
});

// Attachments are uploaded first (see attachments.ts); the text is still required.
export const SubmitMessageRequest = z.strictObject({
  operationId: OperationId,
  mode: MessageMode.default('reject'),
  text: MessageText.refine((text) => text.trim().length > 0, 'Message must not be blank'),
  attachments: MessageAttachments.optional(),
});

export const CancelRunRequest = z.strictObject({ operationId: OperationId, runId: RunId });

// Optional instructions steer what the summary keeps.
export const CompactRequest = z.strictObject({ instructions: z.string().min(1).max(10_000).optional() });

export const OperationReceipt = z.strictObject({
  operationId: OperationId,
  sessionId: SessionId,
  conversationId: ConversationId,
  runId: RunId,
  action: z.enum(['submit_message', 'cancel_run']),
  status: z.literal('accepted'),
  acceptedAt: Timestamp,
});

export const CancelRunResponse = OperationReceipt.extend({
  action: z.literal('cancel_run'),
  // Queued messages the cancellation withdrew, to put back in the editor with their attachments.
  restoredMessages: z
    .array(
      z.strictObject({
        operationId: OperationId,
        mode: MessageMode,
        text: SubmitMessageRequest.shape.text,
        attachments: MessageAttachments.default([]),
      }),
    )
    .max(PENDING_INPUTS_LIMIT)
    .default([]),
});

/**
 * A conversation's state for a client that holds none of it: the session, the newest committed entries (older ones
 * through history, from `history.nextCursor`) and the live layer. GET .../snapshot returns it; `snapshot` events carry it.
 */
export const Snapshot = z.strictObject({
  conversationId: ConversationId,
  session: Session,
  history: HistoryResponse,
  live: LiveState,
});

// GET .../events?after=<entry ID>: resume after that committed entry. `Last-Event-ID` wins when both are sent.
export const EventsQuery = z.strictObject({ after: EntryId.optional() });

/**
 * GET /v1/sessions/:sessionId/conversations/:conversationId/events streams these as server-sent events: `event:` is
 * the kind and `data:` the JSON. Events are ordered within a connection.
 *
 * - `snapshot` replaces everything the client holds live for the conversation: the session, the committed tail and the
 *   live layer. Older pages it fetched through history stay cached by entry ID. A connection starts with one unless it
 *   resumes, and the server may send one at any other time (a reset) when it cannot express a change as the events
 *   below, so a client accepts it whenever it comes.
 * - `session` replaces the session. It doubles as the heartbeat, at least every 15 seconds, because the workspace
 *   state changes without a transcript change.
 * - `entries` carries committed entries in transcript order. Each replaces the entry with the same ID if the client
 *   holds it, and is appended otherwise. `after` is the newest committed entry ID this connection had sent before it
 *   (null if none); a client whose own newest entry differs has missed some, and reconnects.
 * - `live` replaces the live layer whole: the streaming message and running tools. Sent at most about every 100 ms.
 *
 * Resume: `snapshot` and `entries` events set the SSE `id:` to the newest committed entry they leave the client with;
 * other events set none, so the last one stands. A reconnect sends it as `Last-Event-ID` (EventSource does) or as
 * `?after=` (a fresh connection from a cached transcript). When that ID is a committed entry of this conversation and
 * at most HISTORY_PAGE_LIMIT entries behind the newest, the stream starts with `session`, then `entries` after it (none
 * when it is the newest), then `live`. Otherwise, or with no ID, it starts with `snapshot`.
 */
export const SessionEvent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('snapshot'), snapshot: Snapshot }),
  z.strictObject({ kind: z.literal('session'), session: Session }),
  z.strictObject({
    kind: z.literal('entries'),
    after: EntryId.nullable(),
    entries: z.array(Entry).min(1).max(HISTORY_PAGE_LIMIT),
  }),
  z.strictObject({ kind: z.literal('live'), live: LiveState }),
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

export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export type ApiError = z.infer<typeof ApiError>;

export type Session = z.infer<typeof Session>;

export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export type RenameSessionRequest = z.infer<typeof RenameSessionRequest>;

export type SubmitMessageRequest = z.infer<typeof SubmitMessageRequest>;

export type CancelRunRequest = z.infer<typeof CancelRunRequest>;

export type CompactRequest = z.infer<typeof CompactRequest>;

export type OperationReceipt = z.infer<typeof OperationReceipt>;

export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

export type PageQuery = z.infer<typeof PageQuery>;

export type Snapshot = z.infer<typeof Snapshot>;

export type SessionEvent = z.infer<typeof SessionEvent>;

export type CommandRecord = z.infer<typeof CommandRecord>;
