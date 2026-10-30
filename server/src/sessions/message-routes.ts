import { CancelRunRequest, OperationParams, SessionParams, SubmitMessageRequest } from '@cloud-swe/protocol';
import type { Hono } from 'hono';

import type { Env } from '../env';
import { apiError } from '../http';
import { hasSession } from './catalog-store';

export function messageRoutes(app: Hono, env: Env, storage: DurableObjectStorage): void {
  app.post('/v1/sessions/:sessionId/messages', async (c) => {
    const params = SessionParams.safeParse(c.req.param());

    if (!params.success) return apiError(400, 'invalid_request', 'Invalid session ID');
    const { sessionId } = params.data;

    if (!(await hasSession(storage, sessionId))) return apiError(404, 'not_found', 'Session not found');
    const parsed = SubmitMessageRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid message request');

    return env.THREADS.get(env.THREADS.idFromName(sessionId)).submitMessage(parsed.data);
  });

  app.post('/v1/sessions/:sessionId/cancel', async (c) => {
    const params = SessionParams.safeParse(c.req.param());

    if (!params.success) return apiError(400, 'invalid_request', 'Invalid session ID');
    const { sessionId } = params.data;

    if (!(await hasSession(storage, sessionId))) return apiError(404, 'not_found', 'Session not found');
    const parsed = CancelRunRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid cancellation request');

    return env.THREADS.get(env.THREADS.idFromName(sessionId)).cancelRun(parsed.data);
  });

  app.get('/v1/sessions/:sessionId/operations/:operationId', async (c) => {
    const parsed = OperationParams.safeParse(c.req.param());

    if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid operation parameters');
    const { sessionId, operationId } = parsed.data;

    if (!(await hasSession(storage, sessionId))) return apiError(404, 'not_found', 'Session not found');

    return env.THREADS.get(env.THREADS.idFromName(sessionId)).getReceipt(operationId);
  });
}
