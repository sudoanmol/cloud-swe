import { z } from 'zod';

import {
  CreateSessionRequest,
  OperationReceipt,
  Session,
  SessionId,
  SubmitMessageRequest,
  Timestamp,
  Workspace,
  WorkspaceId,
} from './index.ts';

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

// Receipt identity is reserved before Pi dispatch, but returned only after native admission.
export const MessageOperation = z.strictObject({
  request: SubmitMessageRequest,
  model: Session.shape.model,
  receipt: OperationReceipt.extend({ action: z.literal('submit_message') }),
  state: z.enum(['prepared', 'accepted']),
});

export type MessageOperation = z.infer<typeof MessageOperation>;

export const SessionListPosition = z.string().regex(/^session:\d{4}-\d{2}-\d{2}T[0-9:.]+Z:[0-9a-f-]{36}$/);
