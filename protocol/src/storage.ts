/**
 * Path: protocol/src/storage.ts
 * Used by: the @cloud-swe/protocol/storage package export.
 * Purpose: Durable Object record schemas, each its kind's own shape rather than a public API schema, with a version and the steps that upgrade an older row. Never sent to clients.
 */

import { z } from 'zod';

import { EnvironmentName, SecretName, SecretRequest } from './environments.ts';
import { Approval, BranchName, GitSha, PullRequest, RefName, Repo } from './git.ts';
import {
  OperationId,
  PENDING_INPUTS_LIMIT,
  RunId,
  Session,
  SessionId,
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
    // Pi's root conversation, which this session's Thread binds to.
    runtime: z.object({ conversationId: z.string() }),
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

const MessageReceipt = z.object({
  operationId: OperationId,
  sessionId: SessionId,
  runId: RunId,
  action: z.literal('submit_message'),
  status: z.literal('accepted'),
  acceptedAt: Timestamp,
});

// Receipt identity is reserved before Pi dispatch, but returned only after native admission.
export const MessageOperation = storedRecord({
  request: z.object({ operationId: OperationId, mode: MessageMode, text: z.string() }),
  model: Model,
  receipt: MessageReceipt,
  state: z.enum(['prepared', 'accepted']),
  // Server-written context for the model, delivered as its own transcript entry before this message. Never part of
  // `request`, so operation identity and receipts stay based on what the client sent.
  notice: z.string().min(1).max(NOTICE_LIMIT).optional(),
  // Written by the server (an approval result or a question answer), not typed by the user, so a cancellation never
  // hands it back to the editor.
  system: z.literal(true).optional(),
});

export type MessageOperation = z.infer<typeof MessageOperation>;

export const CancelOperation = storedRecord({
  request: z.object({ operationId: OperationId, runId: RunId }),
  messageOperationIds: z.array(OperationId).min(1).max(PENDING_INPUTS_LIMIT),
  // Queued server-written messages the cancellation withdraws. Their text is kept as a notice for the model.
  withdrawnSystemIds: z.array(OperationId).max(PENDING_INPUTS_LIMIT),
  receipt: MessageReceipt.extend({
    action: z.literal('cancel_run'),
    restoredMessages: z.array(z.object({ operationId: OperationId, mode: MessageMode, text: z.string() })),
  }),
  state: z.enum(['prepared', 'accepted']),
});

export type CancelOperation = z.infer<typeof CancelOperation>;

export const HistoryPosition = z.strictObject({
  sessionId: SessionId,
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
export const StoredApproval = storedRecord({
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
});

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

export const StoredQuestion = storedRecord({
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
});

export type StoredQuestion = z.infer<typeof StoredQuestion>;

export const StoredSecretRequest = storedRecord({
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
});

export type StoredSecretRequest = z.infer<typeof StoredSecretRequest>;

export const SessionListPosition = z.string().regex(/^session:\d{4}-\d{2}-\d{2}T[0-9:.]+Z:[0-9a-f-]{36}$/);

// Projections: the public shape of each stored record. Each names the fields it passes, so a stored-only field never
// reaches a client, and a public schema change fails here rather than in storage.

export const approvalView = (approval: StoredApproval['approval']): Approval => Approval.parse(approval);

export const questionView = (question: StoredQuestion['question']): Question => Question.parse(question);

export const secretRequestView = (request: StoredSecretRequest['request']): SecretRequest =>
  SecretRequest.parse(request);

export const repoView = ({ url, path, base }: StoredRepo): Repo => Repo.parse({ url, path, base });

export const pullRequestView = ({ repo, number, title, url, state, head, base }: StoredPullRequest): PullRequest =>
  PullRequest.parse({ repo, number, title, url, state, head, base });

/** What the public session reads live rather than from its stored record. */
export type SessionLive = Omit<z.input<typeof Session>, 'id' | 'title' | 'workspace' | 'environment' | 'createdAt'> & {
  workspaceState: Session['workspace']['state'];
};

export function sessionView(stored: StoredSession, { workspaceState, ...live }: SessionLive): Session {
  return Session.parse({
    ...live,
    id: stored.id,
    title: stored.title,
    workspace: { id: stored.workspace.id, state: workspaceState },
    environment: stored.environment,
    createdAt: stored.createdAt,
  });
}
