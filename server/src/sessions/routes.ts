/**
 * Path: server/src/sessions/routes.ts
 * Used by: server/src/index.ts.
 * Purpose: Every /v1/sessions route, run in the Worker after sign-in: creation and listing go to the Catalog, and the rest straight to the session's Thread once its params check out. The Thread answers 404 for a session it doesn't hold, before any refusal of the body or query.
 */

import {
  CancelRunRequest,
  CompactRequest,
  ConversationParams,
  CreateSessionRequest,
  ListSessionsResponse,
  OperationParams,
  PageQuery,
  RenameSessionRequest,
  SessionParams,
  SubmitMessageRequest,
} from '@cloud-swe/protocol';
import { AnswerSecretRequest, SecretRequestParams } from '@cloud-swe/protocol/environments';
import { ApprovalParams, DecideApprovalRequest } from '@cloud-swe/protocol/git';
import { AnswerQuestionRequest, QuestionParams } from '@cloud-swe/protocol/interaction';
import { SummaryListPosition } from '@cloud-swe/protocol/storage';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import { catalogStub, type Env, threadStub } from '../env.ts';
import { apiError } from '../errors.ts';

type ThreadStub = ReturnType<typeof threadStub>;

type App = Hono<{ Bindings: Env }>;

const conversationPath = '/v1/sessions/:sessionId/conversations/:conversationId';

export function sessionRoutes(app: App): void {
  const threadRoute =
    <P extends z.ZodType<{ sessionId: string }>>(
      schema: P,
      call: (thread: ThreadStub, params: z.output<P>, c: Context<{ Bindings: Env }>) => Promise<Response>,
    ) =>
    async (c: Context<{ Bindings: Env }>) => {
      const params = schema.safeParse(c.req.param());

      if (!params.success) return apiError('invalid_request');

      return call(threadStub(c.env, params.data.sessionId), params.data, c);
    };

  const postToThread = <P extends z.ZodType<{ sessionId: string }>, B extends z.ZodType>(
    paramsSchema: P,
    bodySchema: B,
    call: (thread: ThreadStub, body: z.output<B>, params: z.output<P>) => Promise<Response>,
  ) =>
    threadRoute(paramsSchema, async (thread, params, c) => {
      const body = bodySchema.safeParse(await c.req.json().catch(() => null));

      if (body.success) return call(thread, body.data, params);

      return thread.refuse('invalid_request');
    });

  app.post('/v1/sessions', async (c) => {
    const parsed = CreateSessionRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError('invalid_request');
    // Through a variable: calling the stub inline here fails to typecheck with TS2589.
    const catalog = catalogStub(c.env);

    return catalog.createSession(parsed.data);
  });

  app.get('/v1/sessions', async (c) => {
    const parsed = PageQuery.safeParse(c.req.query());

    if (!parsed.success) return apiError('invalid_request');
    let before: string | undefined;

    if (parsed.data.cursor) {
      try {
        before = SummaryListPosition.parse(atob(parsed.data.cursor));
      } catch {
        return apiError('invalid_cursor');
      }
    }

    const { sessions, next } = await catalogStub(c.env).listSessions(before, parsed.data.limit);

    return c.json(ListSessionsResponse.parse({ sessions, nextCursor: next === undefined ? null : btoa(next) }));
  });

  app.get(
    '/v1/sessions/:sessionId',
    threadRoute(SessionParams, (thread) => thread.session()),
  );

  app.patch(
    '/v1/sessions/:sessionId',
    postToThread(SessionParams, RenameSessionRequest, (thread, { title }) => thread.rename(title)),
  );

  app.post(
    `${conversationPath}/messages`,
    // Nothing can be uploaded until slice S8 adds the attachment routes, so any attachment is unknown.
    postToThread(ConversationParams, SubmitMessageRequest, async (thread, body, { conversationId }) => {
      if (body.attachments?.length) return thread.refuse('attachment_not_found');

      return thread.submitMessage(conversationId, body);
    }),
  );

  app.post(
    `${conversationPath}/cancel`,
    postToThread(ConversationParams, CancelRunRequest, (thread, body, { conversationId }) =>
      thread.cancelRun(conversationId, body),
    ),
  );

  app.post(
    `${conversationPath}/compact`,
    postToThread(ConversationParams, CompactRequest, (thread, body, { conversationId }) =>
      thread.compact(conversationId, body),
    ),
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

  // A receipt of any conversation of the session; the receipt names which.
  app.get(
    '/v1/sessions/:sessionId/operations/:operationId',
    threadRoute(OperationParams, (thread, { operationId }) => thread.getReceipt(operationId)),
  );

  app.get(
    `${conversationPath}/snapshot`,
    threadRoute(ConversationParams, (thread, { conversationId }) => thread.snapshot(conversationId)),
  );

  app.get(
    `${conversationPath}/events`,
    threadRoute(ConversationParams, (thread, { conversationId }) => thread.events(conversationId)),
  );

  app.get(
    `${conversationPath}/history`,
    threadRoute(ConversationParams, async (thread, { conversationId }, c) => {
      const query = PageQuery.safeParse(c.req.query());

      if (!query.success) return thread.refuse('invalid_request');

      return thread.history(conversationId, query.data);
    }),
  );
}
