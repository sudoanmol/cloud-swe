/**
 * Path: server/src/git/approval-routes.ts
 * Used by: server/src/sessions/catalog.ts.
 * Purpose: POST /v1/sessions/:sessionId/approvals/:approvalId, the bearer-authenticated decision route and the only way an approval executes.
 */
import { ApprovalParams, DecideApprovalRequest } from '@cloud-swe/protocol/git';
import type { Hono } from 'hono';

import type { Env } from '../env';
import { apiError } from '../http';
import { hasSession } from '../sessions/catalog-store';

export function approvalRoutes(app: Hono, env: Env, storage: DurableObjectStorage): void {
  app.post('/v1/sessions/:sessionId/approvals/:approvalId', async (c) => {
    const params = ApprovalParams.safeParse(c.req.param());

    if (!params.success) return apiError('invalid_request');
    const { sessionId, approvalId } = params.data;

    if (!(await hasSession(storage, sessionId))) return apiError('session_not_found');
    const parsed = DecideApprovalRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError('invalid_request');

    return env.THREADS.get(env.THREADS.idFromName(sessionId)).decideApproval(approvalId, parsed.data);
  });
}
