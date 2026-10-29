import { z } from 'zod';

import { CreateSessionRequest, SessionId, Timestamp } from './index.ts';

export const SessionCreation = z.strictObject({
  request: CreateSessionRequest,
  sessionId: SessionId,
  createdAt: Timestamp,
});

export type SessionCreation = z.infer<typeof SessionCreation>;

export const SessionListPosition = z.string().regex(/^session:\d{4}-\d{2}-\d{2}T[0-9:.]+Z:[0-9a-f-]{36}$/);
