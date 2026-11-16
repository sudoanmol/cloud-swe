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
  RenameSessionRequest,
  SessionParams,
  sessionSummary,
  SubmitMessageRequest,
} from '@cloud-swe/protocol';
import { AnswerSecretRequest, SecretRequestParams } from '@cloud-swe/protocol/environments';
import { ApprovalParams, DecideApprovalRequest } from '@cloud-swe/protocol/git';
import { AnswerQuestionRequest, QuestionParams } from '@cloud-swe/protocol/interaction';
import { SessionListPosition } from '@cloud-swe/protocol/storage';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import { credentialsStub, type Env, threadStub } from '../env.ts';
import { apiError } from '../errors.ts';
import { hasSession, indexSession, listSessions, readCreation } from './catalog-store.ts';
import { admitCreation } from './create.ts';
import type { WorkspaceLifecycle } from './workspace-lifecycle.ts';

type ThreadStub = ReturnType<typeof threadStub>;

export function sessionRoutes(
  app: Hono,
  storage: DurableObjectStorage,
  env: Env,
  workspaces: WorkspaceLifecycle,
): void {
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

    const { environment, operationId } = parsed.data;

    // Checked only before admission: a retry or a replacement sandbox never depends on the environment still existing.
    if (
      environment &&
      !(await readCreation(storage, operationId)) &&
      !(await credentialsStub(env).hasEnvironment(environment))
    ) {
      return apiError('unknown_environment');
    }

    const admitted = await workspaces.admit(() => admitCreation(storage, env, parsed.data));

    if (admitted instanceof Response) return admitted;
    const { creation, replay } = admitted;
    await workspaces.ensure(creation);
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

    // Until slice S7 reads summary rows from this Catalog: each Thread is asked, a broken one is left out, the order
    // is still by creation and there is no preview.
    const reads = await Promise.allSettled(page.map(({ sessionId }) => threadStub(env, sessionId).getSession()));
    const sessions = reads.flatMap((read) => (read.status === 'fulfilled' ? [sessionSummary(read.value, null)] : []));
    const last = page.at(-1);

    return c.json(ListSessionsResponse.parse({ sessions, nextCursor: hasMore && last ? btoa(last.key) : null }));
  });

  app.get(
    '/v1/sessions/:sessionId',
    threadRoute(SessionParams, async (thread, _params, c) => c.json(await thread.getSession())),
  );

  app.patch(
    '/v1/sessions/:sessionId',
    postToThread(SessionParams, RenameSessionRequest, async (thread, { title }) =>
      Response.json(await thread.rename(title)),
    ),
  );

  app.post(
    '/v1/sessions/:sessionId/messages',
    // Nothing can be uploaded until slice S8 adds the attachment routes, so any attachment is unknown.
    postToThread(SessionParams, SubmitMessageRequest, async (thread, body): Promise<Response> => {
      if (body.attachments?.length) return apiError('attachment_not_found');

      return thread.submitMessage(body);
    }),
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

  app.post(
    '/v1/sessions/:sessionId/questions/:questionId',
    postToThread(QuestionParams, AnswerQuestionRequest, (thread, body, { questionId }) =>
      thread.answerQuestion(questionId, body),
    ),
  );

  // The value goes from this request to the account environment; the Thread keeps only the outcome.
  app.post(
    '/v1/sessions/:sessionId/secret-requests/:requestId',
    postToThread(SecretRequestParams, AnswerSecretRequest, (thread, body, { requestId }) =>
      thread.answerSecretRequest(requestId, body),
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
