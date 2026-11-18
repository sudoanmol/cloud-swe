/**
 * Path: protocol/src/storage.ts
 * Used by: the @cloud-swe/protocol/storage package export.
 * Purpose: Durable Object record schemas, each its kind's own shape rather than a public API schema, with a version and the steps that upgrade an older row. Never sent to clients.
 */

import { z } from 'zod';

import { ATTACHMENT_LIMITS, ImageMediaType } from './attachments.ts';
import { EnvironmentName, SecretName, SecretRequest } from './environments.ts';
import { Approval, BranchName, GitSha, PullRequest, RefName, Repo } from './git.ts';
import {
  AttachmentId,
  OperationId,
  PENDING_INPUTS_LIMIT,
  RunId,
  Session,
  SessionId,
  SessionSummary,
  TemplateName,
  Timestamp,
  WorkspaceId,
} from './index.ts';
import { Question } from './interaction.ts';

/** Any stored record row: its version (a row without one is version 0) and whatever else it holds. */
export const StoredRow = z.looseObject({ version: z.int().nonnegative().default(0) });

export type StoredRow = z.output<typeof StoredRow>;

/** Turns a stored row of one version into the next version. */
type Upgrade = (row: StoredRow) => StoredRow;

const UPGRADES = new WeakMap<z.ZodType, readonly Upgrade[]>();

/** The steps that bring an older row of this kind up to date: `[n]` turns version n into n + 1. Empty for any other schema. */
export const upgradesOf = (schema: z.ZodType): readonly Upgrade[] => UPGRADES.get(schema) ?? [];

/**
 * A persisted record kind. Reads are lenient: a key the schema doesn't know is dropped, not an error. `version`
 * defaults to the current one, so every write stores it. server/src/storage.ts runs the upgrades when a row is read.
 */
function storedRecord<Fields extends Record<string, z.ZodType>>(fields: Fields, upgrades: readonly Upgrade[] = []) {
  const version = upgrades.length;
  const schema = z.object({ ...fields, version: z.literal(version).default(version) });
  UPGRADES.set(schema, upgrades);

  return schema;
}

const Model = z.object({ provider: z.string(), id: z.string() });

const MessageMode = z.enum(['reject', 'steer', 'followUp']);

const WorkspaceProvider = z.enum(['docker', 'e2b']);

export const StoredSession = storedRecord(
  {
    id: SessionId,
    // The active Pi conversation, `Session.activeConversationId`: the root until a rewind makes its fork active.
    // `rewoundAt` is the time of the last rewind, which counts as activity; absent on a session never rewound.
    runtime: z.object({ conversationId: z.string(), rewoundAt: Timestamp.optional() }),
    model: Model,
    workspace: z.object({ id: WorkspaceId }),
    environment: EnvironmentName.nullable().default(null),
    title: z.string().nullable(),
    createdAt: Timestamp,
  },
  // 1: a title, which a session from before titles doesn't have until it is renamed.
  [(row) => ({ ...row, title: null })],
);

export type StoredSession = z.infer<typeof StoredSession>;

// Version 0 always named its template and model in the request.
const CreationV0 = z.looseObject({ request: z.looseObject({ template: TemplateName, model: Model }) });

export const SessionCreation = storedRecord(
  {
    // What the client sent, so a retry with another body under the same operation ID is told apart.
    request: z.object({
      operationId: OperationId,
      template: TemplateName.optional(),
      environment: EnvironmentName.optional(),
      repo: z.object({ url: z.string(), branch: BranchName.optional() }).optional(),
      model: Model.optional(),
    }),
    // What the session got: the request's template and model, or the server's defaults when it left them out.
    template: TemplateName,
    model: Model,
    sessionId: SessionId,
    workspaceId: WorkspaceId,
    createdAt: Timestamp,
  },
  [
    // 1: the template and model move out of the request, which may now leave them out.
    (row) => {
      const { request } = CreationV0.parse(row);

      return { ...row, template: request.template, model: request.model };
    },
  ],
);

export type SessionCreation = z.infer<typeof SessionCreation>;

// Server-only mapping from the app workspace to the backend's own sandbox identity. Not stored on its own.
export const WorkspaceRecord = z.strictObject({
  id: WorkspaceId,
  sessionId: SessionId,
  provider: WorkspaceProvider,
  sandboxId: z.string().min(1).max(128),
});

export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>;

// The catalog's stored entry: the binding plus what it last observed. `running` counts toward MAX_SANDBOXES.
export const WorkspaceEntry = storedRecord({
  id: WorkspaceId,
  sessionId: SessionId,
  provider: WorkspaceProvider,
  sandboxId: z.string().min(1).max(128),
  state: z.enum(['running', 'stopped', 'deleted']),
  // Marked `deleted` before the provider call, so a message arriving meanwhile gets a replacement. Set until the provider confirms.
  deletePending: z.boolean().optional(),
  lastActiveAt: Timestamp,
});

export type WorkspaceEntry = z.infer<typeof WorkspaceEntry>;

export const NOTICE_LIMIT = 4000;

// Pi's ROOT_CONVERSATION_ID. Before conversations were addressable, every session had only that one.
const ROOT_CONVERSATION = '1';

const MessageReceipt = z.object({
  operationId: OperationId,
  sessionId: SessionId,
  conversationId: z.string(),
  runId: RunId,
  action: z.literal('submit_message'),
  status: z.literal('accepted'),
  acceptedAt: Timestamp,
});

// Version 0 receipts were all for the root conversation.
const ReceiptV0 = z.looseObject({ receipt: z.looseObject({}) });

const inRootConversation = (row: StoredRow): StoredRow => {
  const { receipt } = ReceiptV0.parse(row);

  return { ...row, receipt: { ...receipt, conversationId: ROOT_CONVERSATION } };
};

const Attachments = z.array(AttachmentId).optional();

// Receipt identity is reserved before Pi dispatch, but returned only after native admission.
export const MessageOperation = storedRecord(
  {
    request: z.object({ operationId: OperationId, mode: MessageMode, text: z.string(), attachments: Attachments }),
    model: Model,
    receipt: MessageReceipt,
    state: z.enum(['prepared', 'accepted']),
    // Server-written context for the model, delivered as its own transcript entry before this message. Never part of
    // `request`, so operation identity and receipts stay based on what the client sent.
    notice: z.string().min(1).max(NOTICE_LIMIT).optional(),
    // Written by the server (an approval result or a question answer), not typed by the user, so a cancellation never
    // hands it back to the editor.
    system: z.literal(true).optional(),
  },
  // 1: the receipt names its conversation.
  [inRootConversation],
);

export type MessageOperation = z.infer<typeof MessageOperation>;

export const CancelOperation = storedRecord(
  {
    request: z.object({ operationId: OperationId, runId: RunId }),
    messageOperationIds: z.array(OperationId).min(1).max(PENDING_INPUTS_LIMIT),
    // Queued server-written messages the cancellation withdraws. Their text is kept as a notice for the model.
    withdrawnSystemIds: z.array(OperationId).max(PENDING_INPUTS_LIMIT),
    receipt: MessageReceipt.extend({
      action: z.literal('cancel_run'),
      restoredMessages: z.array(
        z.object({ operationId: OperationId, mode: MessageMode, text: z.string(), attachments: Attachments }),
      ),
    }),
    state: z.enum(['prepared', 'accepted']),
  },
  // 1: the receipt names its conversation.
  [inRootConversation],
);

export type CancelOperation = z.infer<typeof CancelOperation>;

// A rewind, written once in the transaction that moves the session to the fork: a retry reads its receipt back.
export const RewindOperation = storedRecord({
  // The conversation the client named and the entry it cut before.
  request: z.object({ operationId: OperationId, conversationId: z.string(), before: z.string() }),
  receipt: z.object({
    operationId: OperationId,
    sessionId: SessionId,
    conversationId: z.string(),
    action: z.literal('rewind_conversation'),
    status: z.literal('accepted'),
    acceptedAt: Timestamp,
  }),
});

export type RewindOperation = z.infer<typeof RewindOperation>;

// A conversation's newest admitted message (key `currentMessage`) or cancellation (key `currentCancellation`), by
// conversation ID, so a run or a cancellation in one conversation never reads or overwrites another's.
const PointerMap = storedRecord({ conversations: z.record(z.string(), OperationId) });

// Before conversations were addressable, the row was the root conversation's operation ID alone. It reads as the map
// and is stored as one at the next write.
export const ConversationPointers = z.union([
  PointerMap,
  OperationId.transform((id) => PointerMap.parse({ conversations: { [ROOT_CONVERSATION]: id } })),
]);

export type ConversationPointers = z.infer<typeof ConversationPointers>;

// One file of an attachment in R2: its object key, type, size, and the MD5 R2 computed, which tells a retry's bytes
// from other bytes.
const StoredImageFile = z.strictObject({
  key: z.string().min(1),
  mediaType: ImageMediaType,
  bytes: z.int().positive(),
  md5: z.string().regex(/^[0-9a-f]{32}$/),
});

// An attachment (key `attachment:<attachmentId>`): its files, each set when uploaded, and whether a message has named
// it. A sent attachment stays for the session's life, since every later model request fetches it again.
export const StoredAttachment = storedRecord({
  model: StoredImageFile.optional(),
  original: StoredImageFile.optional(),
  sent: z.boolean(),
});

export type StoredAttachment = z.infer<typeof StoredAttachment>;

export type StoredImageFile = z.infer<typeof StoredImageFile>;

// Attachments no message has named that a session keeps; a new one past it removes the oldest. Four messages' worth.
export const UNSENT_UPLOAD_LIMIT = 4 * ATTACHMENT_LIMITS.perMessage;

// The IDs of the session's unsent attachments, oldest first (key `uploads`).
export const StoredUploads = storedRecord({ ids: z.array(AttachmentId).max(UNSENT_UPLOAD_LIMIT) });

export type StoredUploads = z.infer<typeof StoredUploads>;

// A history cursor: bound to one conversation, so it is refused on another.
export const HistoryPosition = z.strictObject({
  sessionId: SessionId,
  conversationId: z.string(),
  native: z.strictObject({
    after: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    order: z.literal('descending'),
  }),
});

export type HistoryPosition = z.infer<typeof HistoryPosition>;

// Only the SHA-256 of the per-session Git capability token is stored.
const GitToken = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.number().nonnegative() });

// Every unexpired token stays valid, newest last, so a Git command that started under any of them can finish. Bounded.
export const GIT_TOKEN_LIMIT = 16;

export const GitAccess = storedRecord({ tokens: z.array(GitToken).min(1).max(GIT_TOKEN_LIMIT) });

export type GitAccess = z.infer<typeof GitAccess>;

// One element of the session's repository list, which is stored as an array under one key.
export const StoredRepo = storedRecord({ url: z.string(), path: z.string(), base: z.boolean() });

export type StoredRepo = z.infer<typeof StoredRepo>;

export const StoredPullRequest = storedRecord({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  head: z.string(),
  base: z.string(),
});

export type StoredPullRequest = z.infer<typeof StoredPullRequest>;

const approvalFields = {
  id: z.uuid(),
  repo: z.string(),
  state: z.enum(['pending', 'rejected', 'executing', 'succeeded', 'failed', 'unknown']),
  result: z.string().optional(),
  createdAt: Timestamp,
  decidedAt: Timestamp.optional(),
};

// `delivered` records that the follow-up message for a decision, answer or outcome reached message admission.
// `afterEntry` is the ID of the conversation's newest entry when the request was filed (0 for none): a rewind before
// entry B removes the requests with `afterEntry >= B`, which were filed in the part it cuts.
const afterEntry = z.int().nonnegative();

// Version 1 of each request kind records `afterEntry`. A request filed before then reads as filed before every entry,
// so a rewind never removes it.
const filedBeforeEverything = (row: StoredRow): StoredRow => ({ ...row, afterEntry: 0 });

export const StoredApproval = storedRecord(
  {
    approval: z.discriminatedUnion('kind', [
      z.object({
        ...approvalFields,
        kind: z.literal('ref_update'),
        sha: GitSha,
        targetBranch: BranchName,
        force: z.boolean(),
        expected: GitSha.nullable(),
      }),
      z.object({
        ...approvalFields,
        kind: z.literal('pr_merge'),
        number: z.number().int().positive(),
        method: z.enum(['merge', 'squash', 'rebase']),
        expected: GitSha,
        baseRef: z.string(),
      }),
      z.object({
        ...approvalFields,
        kind: z.literal('ref_change'),
        ref: RefName,
        sha: GitSha.nullable(),
        expected: GitSha.nullable(),
      }),
    ]),
    delivered: z.boolean(),
    afterEntry,
  },
  [filedBeforeEverything],
);

export type StoredApproval = z.infer<typeof StoredApproval>;

const questionFields = {
  id: z.uuid(),
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string(), preview: z.string().optional() })),
      multiSelect: z.boolean(),
    }),
  ),
  createdAt: Timestamp,
};

export const StoredQuestion = storedRecord(
  {
    question: z.discriminatedUnion('state', [
      z.object({ ...questionFields, state: z.literal('pending') }),
      z.object({
        ...questionFields,
        state: z.literal('answered'),
        answers: z.array(
          z.object({
            questionIndex: z.int().nonnegative(),
            selected: z.array(z.string()),
            text: z.string().optional(),
            notes: z.string().optional(),
          }),
        ),
        globalNote: z.string().optional(),
        decidedAt: Timestamp,
      }),
      z.object({ ...questionFields, state: z.literal('declined'), decidedAt: Timestamp }),
    ]),
    delivered: z.boolean(),
    afterEntry,
  },
  [filedBeforeEverything],
);

export type StoredQuestion = z.infer<typeof StoredQuestion>;

export const StoredSecretRequest = storedRecord(
  {
    request: z.object({
      id: z.uuid(),
      environment: EnvironmentName,
      name: SecretName,
      hosts: z.array(z.string()),
      header: z.string(),
      reason: z.string(),
      state: z.enum(['pending', 'provided', 'declined']),
      confirmedHosts: z.array(z.string()).optional(),
      createdAt: Timestamp,
      decidedAt: Timestamp.optional(),
    }),
    delivered: z.boolean(),
    afterEntry,
  },
  [filedBeforeEverything],
);

export type StoredSecretRequest = z.infer<typeof StoredSecretRequest>;

export const SessionListPosition = z.string().regex(/^session:\d{4}-\d{2}-\d{2}T[0-9:.]+Z:[0-9a-f-]{36}$/);

// The Catalog's copy of a session's list row, written by the session when its summary changes, so the list reads only
// the Catalog. Kept by its own lenient schema like any record; `summaryView` makes the public row.
export const StoredSessionSummary = storedRecord({
  sessionId: SessionId,
  activeConversationId: z.string(),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  run: z.looseObject({ kind: z.string() }),
  openRequests: z.int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type StoredSessionSummary = z.infer<typeof StoredSessionSummary>;

// The list's order key and page position: newest activity first, then by session ID.
export const SummaryListPosition = z.string().regex(/^activity:\d{4}-\d{2}-\d{2}T[0-9:.]+Z:[0-9a-f-]{36}$/);

// The app's sign-in code, kept in the Credentials DO until it is exchanged once or expires.
export const StoredSignInCode = storedRecord({
  codeChallenge: z.string(),
  token: z.string(),
  expiresAt: z.number().nonnegative(),
});

export type StoredSignInCode = z.infer<typeof StoredSignInCode>;

// Projections: the public shape of each stored record. Each names the fields it passes, so a stored-only field never
// reaches a client, and a public schema change fails here rather than in storage.

export const approvalView = (approval: StoredApproval['approval']): Approval => Approval.parse(approval);

export const questionView = (question: StoredQuestion['question']): Question => Question.parse(question);

export const secretRequestView = (request: StoredSecretRequest['request']): SecretRequest =>
  SecretRequest.parse(request);

export const repoView = ({ url, path, base }: StoredRepo): Repo => Repo.parse({ url, path, base });

export const pullRequestView = ({ repo, number, title, url, state, head, base }: StoredPullRequest): PullRequest =>
  PullRequest.parse({ repo, number, title, url, state, head, base });

export const summaryView = (row: StoredSessionSummary): SessionSummary =>
  SessionSummary.parse({
    id: row.sessionId,
    title: row.title,
    preview: row.preview,
    run: row.run,
    openRequests: row.openRequests,
    activeConversationId: row.activeConversationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/** What the public session reads live rather than from its stored record. */
export type SessionLive = Omit<
  z.input<typeof Session>,
  'id' | 'title' | 'activeConversationId' | 'workspace' | 'environment' | 'createdAt'
> & {
  workspaceState: Session['workspace']['state'];
};

export function sessionView(stored: StoredSession, { workspaceState, ...live }: SessionLive): Session {
  return Session.parse({
    ...live,
    id: stored.id,
    title: stored.title,
    activeConversationId: stored.runtime.conversationId,
    workspace: { id: stored.workspace.id, state: workspaceState },
    environment: stored.environment,
    createdAt: stored.createdAt,
  });
}
