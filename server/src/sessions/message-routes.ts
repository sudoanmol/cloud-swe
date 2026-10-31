import {
  CancelRunRequest,
  CompactRequest,
  OperationParams,
  SessionParams,
  SubmitMessageRequest,
} from '@cloud-swe/protocol';
import type { Hono } from 'hono';

import type { Env } from '../env.ts';
import { apiError } from '../errors.ts';
import { hasSession } from './catalog-store.ts';

export function messageRoutes(app: Hono, env: Env, storage: DurableObjectStorage): void {
  app.post('/v1/sessions/:sessionId/messages', async (c) => {
    const params = SessionParams.safeParse(c.req.param());

    if (!params.success) return apiError('invalid_request');
    const { sessionId } = params.data;

    if (!(await hasSession(storage, sessionId))) return apiError('session_not_found');
    const parsed = SubmitMessageRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError('invalid_request');

    return env.THREADS.get(env.THREADS.idFromName(sessionId)).submitMessage(parsed.data);
  });

  app.post('/v1/sessions/:sessionId/cancel', async (c) => {
    const params = SessionParams.safeParse(c.req.param());

    if (!params.success) return apiError('invalid_request');
    const { sessionId } = params.data;

    if (!(await hasSession(storage, sessionId))) return apiError('session_not_found');
    const parsed = CancelRunRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError('invalid_request');

    return env.THREADS.get(env.THREADS.idFromName(sessionId)).cancelRun(parsed.data);
  });

  app.post('/v1/sessions/:sessionId/compact', async (c) => {
    const params = SessionParams.safeParse(c.req.param());

    if (!params.success) return apiError('invalid_request');
    const { sessionId } = params.data;

    if (!(await hasSession(storage, sessionId))) return apiError('session_not_found');
    const parsed = CompactRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError('invalid_request');

    return env.THREADS.get(env.THREADS.idFromName(sessionId)).compact(parsed.data);
  });

  app.get('/v1/sessions/:sessionId/operations/:operationId', async (c) => {
    const parsed = OperationParams.safeParse(c.req.param());

    if (!parsed.success) return apiError('invalid_request');
    const { sessionId, operationId } = parsed.data;

    if (!(await hasSession(storage, sessionId))) return apiError('session_not_found');

    return env.THREADS.get(env.THREADS.idFromName(sessionId)).getReceipt(operationId);
  });
}
