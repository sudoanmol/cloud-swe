/**
 * Path: protocol/src/storage.ts
 * Used by: the @cloud-swe/protocol/storage package export.
 * Purpose: Durable Object record schemas: creation intents, workspace records and message intents. Never sent to clients.
 */

import { z } from 'zod';

import { Approval } from './git.ts';
import {
  CancelRunRequest,
  CancelRunResponse,
  CreateSessionRequest,
  OperationReceipt,
  Session,
  SessionId,
  SubmitMessageRequest,
  Timestamp,
  Workspace,
  WorkspaceId,
} from './index.ts';
import { Question } from './interaction.ts';

export const SessionCreation = z.strictObject({
  request: CreateSessionRequest,
  sessionId: SessionId,
  workspaceId: WorkspaceId,
  createdAt: Timestamp,
});

export type SessionCreation = z.infer<typeof SessionCreation>;

// Server-only mapping from the app workspace to the backend's own sandbox identity.
export const WorkspaceRecord = z.strictObject({
  id: WorkspaceId,
  sessionId: SessionId,
  provider: Workspace.shape.provider,
  sandboxId: z.string().min(1).max(128),
});

export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>;

// The catalog's stored entry: the binding plus what it last observed. `running` counts toward MAX_SANDBOXES.
export const WorkspaceEntry = WorkspaceRecord.extend({
  state: z.enum(['running', 'stopped', 'deleted']),
  // Marked `deleted` before the Boat call, so a message arriving meanwhile gets a replacement. Set until Boat confirms.
  deletePending: z.boolean().optional(),
  lastActiveAt: Timestamp,
});

export type WorkspaceEntry = z.infer<typeof WorkspaceEntry>;

// Receipt identity is reserved before Pi dispatch, but returned only after native admission.
export const MessageOperation = z.strictObject({
  request: SubmitMessageRequest,
  model: Session.shape.model,
  receipt: OperationReceipt.extend({ action: z.literal('submit_message') }),
  state: z.enum(['prepared', 'accepted']),
  // Server-written context for the model, delivered as its own transcript entry before this message. Never part of
  // `request`, so operation identity and receipts stay based on what the client sent.
  notice: z.string().min(1).max(4000).optional(),
});

export type MessageOperation = z.infer<typeof MessageOperation>;

export const CancelOperation = z.strictObject({
  request: CancelRunRequest,
  messageOperationIds: z.array(OperationReceipt.shape.operationId).min(1).max(100),
  receipt: CancelRunResponse,
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
const GitToken = z.strictObject({ hash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.number().nonnegative() });

// Every unexpired token stays valid, newest last, so a Git command that started under any of them can finish. Bounded.
export const GIT_TOKEN_LIMIT = 16;

export const GitAccess = z.strictObject({ tokens: z.array(GitToken).min(1).max(GIT_TOKEN_LIMIT) });

export type GitAccess = z.infer<typeof GitAccess>;

// `delivered` records that the decision's follow-up message reached message admission.
export const StoredApproval = z.strictObject({ approval: Approval, delivered: z.boolean() });

export type StoredApproval = z.infer<typeof StoredApproval>;

// `delivered` records that the answer's follow-up message reached message admission.
export const StoredQuestion = z.strictObject({ question: Question, delivered: z.boolean() });

export type StoredQuestion = z.infer<typeof StoredQuestion>;

export const SessionListPosition = z.string().regex(/^session:\d{4}-\d{2}-\d{2}T[0-9:.]+Z:[0-9a-f-]{36}$/);
