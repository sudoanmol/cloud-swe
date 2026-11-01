/**
 * Path: server/src/sessions/routes.ts
 * Used by: server/src/sessions/catalog.ts.
 * Purpose: Every /v1/sessions route: creation and listing here, the rest checked (params, then existence) and forwarded to the session Thread.
 */

import {
  CancelRunRequest,
  CompactRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsResponse,
  OperationParams,
  PageQuery,
  Session,
  SessionParams,
  SubmitMessageRequest,
} from '@cloud-swe/protocol';
import { ApprovalParams, DecideApprovalRequest } from '@cloud-swe/protocol/git';
import { SessionListPosition } from '@cloud-swe/protocol/storage';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import { type Env, threadStub } from '../env.ts';
import { apiError } from '../errors.ts';
import { hasSession, indexSession, listSessions } from './catalog-store.ts';
import { admitCreation, ensureWorkspace } from './create.ts';
import type { WorkspaceLifecycle } from './workspace-lifecycle.ts';

type ThreadStub = ReturnType<typeof threadStub>;

export function sessionRoutes(app: Hono, ctx: DurableObjectState, env: Env, workspaces: WorkspaceLifecycle): void {
  const { storage } = ctx;

  /** Every per-session route checks its params, then that the session exists, before it reaches the Thread. */
  const threadRoute =
    <P extends z.ZodType<{ sessionId: string }>>(
      schema: P,
      call: (thread: ThreadStub, params: z.output<P>, c: Context) => Promise<Response>,
    ) =>
    async (c: Context) => {
      const params = schema.safeParse(c.req.param());

      if (!params.success) return apiError('invalid_request');

      if (!(await hasSession(storage, params.data.sessionId))) return apiError('session_not_found');

      return call(threadStub(env, params.data.sessionId), params.data, c);
    };

  const postToThread = <P extends z.ZodType<{ sessionId: string }>, B extends z.ZodType>(
    paramsSchema: P,
    bodySchema: B,
    call: (thread: ThreadStub, body: z.output<B>, params: z.output<P>) => Promise<Response>,
  ) =>
    threadRoute(paramsSchema, async (thread, params, c) => {
      const body = bodySchema.safeParse(await c.req.json().catch(() => null));

      return body.success ? call(thread, body.data, params) : apiError('invalid_request');
    });

  app.post('/v1/sessions', async (c) => {
    const parsed = CreateSessionRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError('invalid_request');

    // Correct a full-looking cap against Boat first; the gate below only counts stored state.
    await workspaces.refreshIfFull();

    // Serialize only admission, so parallel creations provision their sandboxes concurrently.
    const admitted = await ctx.blockConcurrencyWhile(() => admitCreation(storage, env, parsed.data));

    if (admitted instanceof Response) return admitted;
    const { creation, replay } = admitted;
    await ensureWorkspace(storage, env, creation);
    await workspaces.scheduleSweep();
    const session = await threadStub(env, creation.sessionId).initialize(creation);

    await indexSession(storage, creation, session.createdAt);

    return c.json(
      CreateSessionResponse.parse({ operationId: creation.request.operationId, session }),
      replay ? 200 : 201,
    );
  });

  app.get('/v1/sessions', async (c) => {
    const parsed = PageQuery.safeParse(c.req.query());

    if (!parsed.success) return apiError('invalid_request');
    let startAfter: string | undefined;

    if (parsed.data.cursor) {
      try {
        startAfter = SessionListPosition.parse(atob(parsed.data.cursor));
      } catch {
        return apiError('invalid_cursor');
      }
    }

    const { page, hasMore } = await listSessions(storage, startAfter, parsed.data.limit);

    // One broken Thread must not hide the rest; name it so the client knows the page is incomplete.
    const ids = page.map(({ sessionId }) => sessionId);
    const reads = await Promise.allSettled(ids.map((sessionId) => threadStub(env, sessionId).getSession()));
    const sessions = reads.flatMap((read) => (read.status === 'fulfilled' ? [read.value] : []));
    const unavailable = ids.filter((_, index) => reads[index]?.status === 'rejected');
    const last = page.at(-1);

    return c.json(
      ListSessionsResponse.parse({ sessions, unavailable, nextCursor: hasMore && last ? btoa(last.key) : null }),
    );
  });

  app.get(
    '/v1/sessions/:sessionId',
    threadRoute(SessionParams, async (thread, _params, c) => c.json(Session.parse(await thread.getSession()))),
  );

  app.post(
    '/v1/sessions/:sessionId/messages',
    postToThread(SessionParams, SubmitMessageRequest, (thread, body) => thread.submitMessage(body)),
  );

  app.post(
    '/v1/sessions/:sessionId/cancel',
    postToThread(SessionParams, CancelRunRequest, (thread, body) => thread.cancelRun(body)),
  );

  app.post(
    '/v1/sessions/:sessionId/compact',
    postToThread(SessionParams, CompactRequest, (thread, body) => thread.compact(body)),
  );

  // The bearer-authenticated decision route, and the only way an approval executes.
  app.post(
    '/v1/sessions/:sessionId/approvals/:approvalId',
    postToThread(ApprovalParams, DecideApprovalRequest, (thread, body, { approvalId }) =>
      thread.decideApproval(approvalId, body),
    ),
  );

  app.get(
    '/v1/sessions/:sessionId/operations/:operationId',
    threadRoute(OperationParams, (thread, { operationId }) => thread.getReceipt(operationId)),
  );

  app.get(
    '/v1/sessions/:sessionId/snapshot',
    threadRoute(SessionParams, (thread) => thread.snapshot()),
  );

  app.get(
    '/v1/sessions/:sessionId/events',
    threadRoute(SessionParams, (thread) => thread.events()),
  );

  app.get(
    '/v1/sessions/:sessionId/history',
    threadRoute(SessionParams, async (thread, _params, c) => {
      const query = PageQuery.safeParse(c.req.query());

      if (!query.success) return apiError('invalid_request');

      return thread.history(query.data);
    }),
  );
}
