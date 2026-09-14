import { modelSelectionSchema } from "@cloud-swe/db/model-selection";
import { registerModelRoutes, type ModelCredentials } from "./models";
import { registerAttachmentRoutes, type AttachmentStore } from "./attachments";
import type { AttachmentObjectStore } from "@cloud-swe/db/attachment-objects";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  MessageInput,
  SubmitInput,
  SubmitResult,
  ThreadEvent,
  ThreadView,
  ThreadListInput,
  ThreadSummary,
  ThreadStore,
} from "@cloud-swe/db/thread-contracts";
import { questionAnswersSchema } from "@cloud-swe/db/question-contracts";
import { publicFailure } from "@cloud-swe/db/public-failure";
import { normalizeGitHubBranch, normalizeGitHubUrl } from "@cloud-swe/db/repository-url";
import { z } from "zod";

import { createContext, type AuthProvider, type AuthSession } from "../context";
import { logFailure, sendError } from "../http";
import { consumeThreadEventStream, type EventStreamItem, writeFrame } from "../server-events";
import { checkMutationSecurity, hasRequestBody, readHeader, UserRateLimiter } from "../security";

declare module "fastify" {
  interface FastifyRequest {
    threadUserId: string | null;
  }
}

const promptFields = {
  modelSelection: modelSelectionSchema.optional(),
  prompt: z.string().trim().max(100_000),
  clientMessageId: z.string().min(1).max(255),
  attachmentIds: z.array(z.uuid()).max(10).optional(),
};

const repositoryUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    const normalized = normalizeGitHubUrl(value);

    if (!normalized) {
      context.addIssue({ code: "custom", message: "Only HTTPS GitHub URLs are supported" });

      return z.NEVER;
    }

    return normalized;
  });

const repositoryBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .transform((value, context) => {
    const normalized = normalizeGitHubBranch(value);

    if (!normalized) {
      context.addIssue({ code: "custom", message: "Invalid GitHub branch name" });

      return z.NEVER;
    }

    return normalized;
  });

const initialPromptBody = z
  .object({
    ...promptFields,
    repositoryUrl: repositoryUrlSchema.optional(),
    branch: repositoryBranchSchema.optional(),
  })
  .superRefine((body, context) => {
    if (body.branch && !body.repositoryUrl)
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "branch requires repositoryUrl",
      });

    if (!body.prompt && !body.attachmentIds?.length)
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "Prompt or attachment required",
      });
  })
  .strict();

const followupPromptBody = z
  .object(promptFields)
  .strict()
  .superRefine((body, context) => {
    if (!body.prompt && !body.attachmentIds?.length)
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "Prompt or attachment required",
      });
  });

const idParam = z.object({ id: z.uuid() });

const runParam = idParam.extend({ runId: z.uuid() });

const questionParam = idParam.extend({ requestId: z.uuid() });

const answerBody = z.object({ answers: questionAnswersSchema }).strict();

const cursor = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(2_147_483_647));

export interface ThreadRouteStore {
  submitThread(input: SubmitInput): Promise<SubmitResult>;
  submitMessage(input: MessageInput): Promise<SubmitResult>;
  listThreads(input: ThreadListInput): Promise<ThreadSummary[]>;
  getThread(input: { userId: string; threadId: string }): Promise<ThreadView>;
  authorizeThread(input: { userId: string; threadId: string }): Promise<void>;
  listEvents(input: { threadId: string; after?: number; limit?: number }): Promise<ThreadEvent[]>;
  requestCancel(input: { userId: string; threadId: string; runId: string }): Promise<void>;
  listQuestionRequests: ThreadStore["listQuestionRequests"];
  answerQuestionRequest: ThreadStore["answerQuestionRequest"];
}

export interface ThreadRateLimitOptions {
  max: number;
  windowMs: number;
  maxEntries?: number;
}

export interface ThreadRouteOptions {
  attachmentStore?: AttachmentStore;
  attachmentObjects?: AttachmentObjectStore;
  modelCredentials?: ModelCredentials;
  requireModelSelection?: boolean;
  store: ThreadRouteStore;
  auth: AuthProvider;
  trustedOrigins: readonly string[];
  runLimit?: number;
  pollMs?: number;
  heartbeatMs?: number;
  nodeEnv?: "development" | "test" | "production";
  allowUnverifiedCompute?: boolean;
  computeAccess?: (userId: string) => Promise<{ owner: boolean; trusted: boolean }>;
  rateLimit?: ThreadRateLimitOptions;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Map a caught store rejection to a safe HTTP error response.
function storeError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const failure = publicFailure(error);

  if (failure.statusCode >= 500) {
    logFailure(request, error, "Thread request failed");

    return sendError(reply, failure.statusCode, "INTERNAL_ERROR", "Unable to process request");
  }

  return sendError(reply, failure.statusCode, failure.code, failure.message);
}

function sendSecurityError(reply: FastifyReply, error: ReturnType<typeof checkMutationSecurity>) {
  if (!error) return false;
  sendError(reply, 403, error.code, error.message);

  return true;
}

function sendRateLimitError(reply: FastifyReply, retryAfterMs: number) {
  reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));

  return sendError(reply, 429, "RATE_LIMITED", "Too many run requests. Try again later");
}

async function admitSubmission(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ThreadRouteOptions,
  limiter: UserRateLimiter,
  userId: string,
) {
  try {
    const access = await options.computeAccess?.(userId);
    const retryAfterMs = access?.owner ? null : limiter.consume(userId);

    if (retryAfterMs !== null) {
      sendRateLimitError(reply, retryAfterMs);

      return false;
    }

    if (
      access?.trusted ||
      (options.nodeEnv !== undefined &&
        options.nodeEnv !== "production" &&
        options.allowUnverifiedCompute === true)
    )
      return true;
    sendError(
      reply,
      403,
      "COMPUTE_ADMISSION_REQUIRED",
      "Sign in with GitHub before starting a live-demo task",
    );

    return false;
  } catch (error) {
    logFailure(request, error, "Compute policy lookup failed");
    sendError(reply, 503, "ADMISSION_UNAVAILABLE", "Compute admission is temporarily unavailable");

    return false;
  }
}

function eventFrame(event: ThreadEvent): string {
  const data = JSON.stringify(event.payload) ?? "null";

  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

export function registerThreadRoutes(app: FastifyInstance, options: ThreadRouteOptions) {
  const runLimit = options.runLimit ?? 5;
  const pollMs = options.pollMs ?? 200;
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  const rateLimiter = new UserRateLimiter(
    options.rateLimit ?? { max: 20, windowMs: 60_000, maxEntries: 10_000 },
  );

  const activeStreams = new Set<() => void>();
  let closing = false;
  const streamUsers = new Map<string, number>();
  app.addHook("preClose", async () => {
    closing = true;

    for (const close of activeStreams) close();
  });

  app.register(async (routes) => {
    routes.decorateRequest("threadUserId", null);
    routes.addHook("preHandler", async (request, reply) => {
      const securityError = checkMutationSecurity(request, {
        trustedOrigins: options.trustedOrigins,
        requireJsonBody: hasRequestBody(request),
      });

      if (sendSecurityError(reply, securityError)) return;

      let session: AuthSession | null;

      try {
        session = (await createContext(options.auth, request.headers)).session;
      } catch (error) {
        logFailure(request, error, "Authentication lookup failed");

        return sendError(
          reply,
          503,
          "AUTH_UNAVAILABLE",
          "Authentication is temporarily unavailable",
        );
      }

      request.threadUserId = session?.user.id ?? null;

      if (!request.threadUserId)
        return sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
    });

    routes.register(async (modelRoutes) =>
      registerModelRoutes(modelRoutes, options.modelCredentials),
    );

    if (options.attachmentStore)
      registerAttachmentRoutes(routes, {
        store: options.attachmentStore,
        objects: options.attachmentObjects,
        nodeEnv: options.nodeEnv,
        allowUnverifiedCompute: options.allowUnverifiedCompute,
        computeAccess: options.computeAccess,
      });

    routes.post("/api/threads", async (request, reply) => {
      const userId = request.threadUserId;

      if (!userId) return;
      const body = initialPromptBody.safeParse(request.body);

      if (!body.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid thread payload");

      if (options.requireModelSelection && !body.data.modelSelection)
        return sendError(
          reply,
          400,
          "MODEL_SELECTION_REQUIRED",
          "Choose a provider, model, and thinking level",
        );

      if (body.data.attachmentIds?.length && !options.attachmentObjects)
        return sendError(
          reply,
          503,
          "ATTACHMENT_STORAGE_UNAVAILABLE",
          "Attachment storage is not configured",
        );

      if (!(await admitSubmission(request, reply, options, rateLimiter, userId))) return;

      try {
        const { branch, ...requestData } = body.data;

        const result = await options.store.submitThread({
          ...requestData,
          repositoryBranch: branch,
          userId,
          maxActiveRuns: runLimit,
        });

        return reply.status(202).send(result);
      } catch (error) {
        return storeError(request, reply, error);
      }
    });

    routes.post("/api/threads/:id/messages", async (request, reply) => {
      const userId = request.threadUserId;

      if (!userId) return;
      const params = idParam.safeParse(request.params);
      const body = followupPromptBody.safeParse(request.body);

      if (!params.success || !body.success)
        return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid message payload");

      if (options.requireModelSelection && !body.data.modelSelection)
        return sendError(
          reply,
          400,
          "MODEL_SELECTION_REQUIRED",
          "Choose a provider, model, and thinking level",
        );

      if (body.data.attachmentIds?.length && !options.attachmentObjects)
        return sendError(
          reply,
          503,
          "ATTACHMENT_STORAGE_UNAVAILABLE",
          "Attachment storage is not configured",
        );

      if (!(await admitSubmission(request, reply, options, rateLimiter, userId))) return;

      try {
        const result = await options.store.submitMessage({
          ...body.data,
          threadId: params.data.id,
          userId,
          maxActiveRuns: runLimit,
        });

        return reply.status(202).send(result);
      } catch (error) {
        return storeError(request, reply, error);
      }
    });

    routes.get("/api/threads", async (request, reply) => {
      const userId = request.threadUserId;

      if (!userId) return;

      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before: z.string().max(512).optional(),
        })
        .strict()
        .safeParse(request.query);

      if (!query.success)
        return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid thread list query");
      let before: ThreadListInput["before"];

      if (query.data.before) {
        try {
          before = z
            .object({
              createdAt: z.iso.datetime().transform((value) => new Date(value)),
              id: z.uuid(),
            })
            .strict()
            .parse(JSON.parse(Buffer.from(query.data.before, "base64url").toString("utf8")));
        } catch {
          return sendError(reply, 400, "INVALID_CURSOR", "Invalid thread list cursor");
        }
      }

      try {
        const rows = await options.store.listThreads({
          userId,
          before,
          limit: query.data.limit + 1,
        });

        const threads = rows.slice(0, query.data.limit);
        const last = threads.at(-1);

        const nextCursor =
          rows.length > query.data.limit && last
            ? Buffer.from(
                JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
              ).toString("base64url")
            : null;

        return reply.send({ threads, nextCursor });
      } catch (error) {
        return storeError(request, reply, error);
      }
    });

    routes.get("/api/threads/:id", async (request, reply) => {
      const userId = request.threadUserId;

      if (!userId) return;
      const params = idParam.safeParse(request.params);

      if (!params.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid thread id");

      try {
        return reply.send(await options.store.getThread({ threadId: params.data.id, userId }));
      } catch (error) {
        return storeError(request, reply, error);
      }
    });

    routes.get("/api/threads/:id/questions", async (request, reply) => {
      const userId = request.threadUserId;

      if (!userId) return;
      const params = idParam.safeParse(request.params);

      if (!params.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid thread id");

      try {
        return reply.send({
          requests: await options.store.listQuestionRequests({
            userId,
            threadId: params.data.id,
          }),
        });
      } catch (error) {
        return storeError(request, reply, error);
      }
    });

    routes.post("/api/threads/:id/questions/:requestId/answer", async (request, reply) => {
      const userId = request.threadUserId;

      if (!userId) return;
      const params = questionParam.safeParse(request.params);
      const body = answerBody.safeParse(request.body);

      if (!params.success || !body.success)
        return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid question answer");

      try {
        return reply.send(
          await options.store.answerQuestionRequest({
            userId,
            threadId: params.data.id,
            requestId: params.data.requestId,
            answers: body.data.answers,
          }),
        );
      } catch (error) {
        return storeError(request, reply, error);
      }
    });

    routes.post("/api/threads/:id/runs/:runId/cancel", async (request, reply) => {
      const userId = request.threadUserId;

      if (!userId) return;
      const params = runParam.safeParse(request.params);

      if (!params.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid run id");

      try {
        await options.store.requestCancel({
          runId: params.data.runId,
          threadId: params.data.id,
          userId,
        });

        return reply.status(202).send({ runId: params.data.runId, cancelRequested: true });
      } catch (error) {
        return storeError(request, reply, error);
      }
    });

    routes.get<{ Querystring: { after?: string } }>(
      "/api/threads/:id/events",
      async (request, reply) => {
        const userId = request.threadUserId;

        if (!userId) return;
        const params = idParam.safeParse(request.params);

        if (!params.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid thread id");

        const parsedCursor = cursor.safeParse(
          request.query.after ?? readHeader(request.headers["last-event-id"]) ?? "0",
        );

        if (!parsedCursor.success)
          return sendError(
            reply,
            400,
            "INVALID_CURSOR",
            "Event cursor must be a non-negative integer",
          );

        if (closing || reply.raw.destroyed || request.raw.destroyed) return reply.code(503).send();

        if (activeStreams.size >= 100 || (streamUsers.get(userId) ?? 0) >= 5)
          return sendError(reply, 429, "SSE_LIMIT", "Too many event readers");
        const abort = new AbortController();

        const cleanup = () => {
          if (!activeStreams.delete(close)) return;
          const remaining = (streamUsers.get(userId) ?? 1) - 1;

          if (remaining) streamUsers.set(userId, remaining);
          else streamUsers.delete(userId);
          reply.raw.off("close", close);
          reply.raw.off("error", close);
        };

        const close = () => {
          abort.abort();
          cleanup();

          if (!reply.raw.destroyed) reply.raw.destroy();
        };

        activeStreams.add(close);
        streamUsers.set(userId, (streamUsers.get(userId) ?? 0) + 1);
        reply.raw.once("close", close);
        reply.raw.once("error", close);

        let batch: ThreadEvent[];

        try {
          await options.store.authorizeThread({ threadId: params.data.id, userId });

          if (abort.signal.aborted || closing || reply.raw.destroyed) {
            close();

            return;
          }

          batch = await options.store.listEvents({
            threadId: params.data.id,
            after: parsedCursor.data,
            limit: 100,
          });
        } catch (error) {
          cleanup();

          if (abort.signal.aborted) return;

          return storeError(request, reply, error);
        }

        if (abort.signal.aborted || closing || reply.raw.destroyed) {
          close();

          return;
        }

        reply.hijack();

        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) reply.raw.setHeader(name, value);
        }

        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        reply.raw.flushHeaders();

        try {
          await consumeThreadEventStream(
            {
              store: options.store,
              threadId: params.data.id,
              after: parsedCursor.data,
              initialBatch: batch,
              pollMs,
              heartbeatMs,
            },
            (item: EventStreamItem) =>
              writeFrame(
                reply.raw,
                item.kind === "event" ? eventFrame(item.event) : ": heartbeat\n\n",
              ),
            abort.signal,
          );
        } catch (error) {
          if (!abort.signal.aborted) logFailure(request, error, "SSE event polling failed");
        } finally {
          reply.raw.off("close", close);
          reply.raw.off("error", close);
          close();
        }
      },
    );
  });
}
