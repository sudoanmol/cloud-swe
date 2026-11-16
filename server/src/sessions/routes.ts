/**
 * Path: server/src/sessions/routes.ts
 * Used by: server/src/index.ts.
 * Purpose: Every /v1/sessions route, run in the Worker after sign-in: creation and listing go to the Catalog, and the rest straight to the session's Thread once its params check out. The Thread answers 404 for a session it doesn't hold, before any refusal of the body or query.
 */

import {
  type ApiErrorCode,
  CancelRunRequest,
  CompactRequest,
  ConversationParams,
  CreateSessionRequest,
  EventsQuery,
  ListSessionsResponse,
  OperationParams,
  PageQuery,
  RenameSessionRequest,
  SessionParams,
  SubmitMessageRequest,
} from '@cloud-swe/protocol';
import { ATTACHMENT_LIMITS, AttachmentParams, ImageMediaType } from '@cloud-swe/protocol/attachments';
import { AnswerSecretRequest, SecretRequestParams } from '@cloud-swe/protocol/environments';
import { ApprovalParams, DecideApprovalRequest } from '@cloud-swe/protocol/git';
import { AnswerQuestionRequest, QuestionParams } from '@cloud-swe/protocol/interaction';
import { SummaryListPosition } from '@cloud-swe/protocol/storage';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';

import { catalogStub, type Env, threadStub } from '../env.ts';
import { apiError } from '../errors.ts';
import { type AttachmentFile, imageSize, serveFile, storeFile } from './attachments.ts';

type ThreadStub = ReturnType<typeof threadStub>;

type App = Hono<{ Bindings: Env }>;

const conversationPath = '/v1/sessions/:sessionId/conversations/:conversationId';

/** Where an image's model copy is uploaded (PUT) and fetched (GET); its original is under `/original`. */
export const ATTACHMENT_PATH = '/v1/sessions/:sessionId/attachments/:attachmentId';

export const ORIGINAL_PATH = `${ATTACHMENT_PATH}/original`;

const UPLOAD_LIMITS = { model: ATTACHMENT_LIMITS.modelBytes, original: ATTACHMENT_LIMITS.originalBytes };

/** A refused upload. A bad session ID is 400; an unknown session still answers 404 first. */
async function refuseUpload(c: Context<{ Bindings: Env }>, code: ApiErrorCode): Promise<Response> {
  const params = AttachmentParams.safeParse(c.req.param());

  if (!params.success) return apiError('invalid_request');

  return threadStub(c.env, params.data.sessionId).refuse(code);
}

/**
 * An upload's handlers, registered ahead of the global body limit, after sign-in. Its own limit refuses a body with a
 * larger Content-Length before reading it, and stops reading a streamed one at the limit. An original streams into R2;
 * a model copy is read whole, at most 5 MiB, because its header is checked first.
 */
export const attachmentUpload = (file: AttachmentFile) =>
  [
    bodyLimit({ maxSize: UPLOAD_LIMITS[file], onError: (c) => refuseUpload(c, 'attachment_too_large') }),
    async (c: Context<{ Bindings: Env }>) => {
      const params = AttachmentParams.safeParse(c.req.param());

      if (!params.success) return apiError('invalid_request');
      const mediaType = ImageMediaType.safeParse(c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase());

      if (!mediaType.success) return refuseUpload(c, 'attachment_type_unsupported');
      // R2 needs a stream's length up front; a chunked body was already read whole by the body limit.
      const sized = c.req.header('Content-Length') !== undefined && c.req.header('Transfer-Encoding') === undefined;
      const body = file === 'original' && sized && c.req.raw.body ? c.req.raw.body : await c.req.arrayBuffer();
      const empty = body instanceof ArrayBuffer ? body.byteLength === 0 : c.req.header('Content-Length') === '0';

      if (body instanceof ArrayBuffer && body.byteLength > UPLOAD_LIMITS[file])
        return refuseUpload(c, 'attachment_too_large');

      if (empty) return refuseUpload(c, 'invalid_request');

      if (file === 'model' && body instanceof ArrayBuffer) {
        const size = imageSize(new Uint8Array(body), mediaType.data);

        if (!size) return refuseUpload(c, 'attachment_type_unsupported');

        if (Math.max(size.width, size.height) > ATTACHMENT_LIMITS.modelEdge)
          return refuseUpload(c, 'attachment_dimensions_too_large');
      }

      const thread = threadStub(c.env, params.data.sessionId);

      // Nothing reaches R2 for a session that doesn't exist.
      if (!(await thread.exists())) return thread.refuse('session_not_found');

      return storeFile(c.env, thread, params.data, file, mediaType.data, body);
    },
  ] as const;

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
    postToThread(ConversationParams, SubmitMessageRequest, (thread, body, { conversationId }) =>
      thread.submitMessage(conversationId, body),
    ),
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
    threadRoute(ConversationParams, async (thread, { conversationId }, c) => {
      const query = EventsQuery.safeParse(c.req.query());

      if (!query.success) return thread.refuse('invalid_request');

      // EventSource sends the newest ID it saw on its own reconnects, which is newer than the URL it was opened with.
      return thread.events(conversationId, c.req.header('Last-Event-ID') || query.data.after);
    }),
  );

  for (const [path, file] of [
    [ATTACHMENT_PATH, 'model'],
    [ORIGINAL_PATH, 'original'],
  ] as const) {
    app.get(
      path,
      threadRoute(AttachmentParams, async (thread, { attachmentId }, c) =>
        serveFile(c.env, await thread.attachmentFile(attachmentId, file)),
      ),
    );
  }

  app.get(
    `${conversationPath}/history`,
    threadRoute(ConversationParams, async (thread, { conversationId }, c) => {
      const query = PageQuery.safeParse(c.req.query());

      if (!query.success) return thread.refuse('invalid_request');

      return thread.history(conversationId, query.data);
    }),
  );
}
