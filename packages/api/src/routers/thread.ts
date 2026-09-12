import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  MessageInput,
  SubmitInput,
  SubmitResult,
  ThreadEvent,
  ThreadView,
} from "@cloud-swe/db/thread-contracts";
import { publicFailure } from "@cloud-swe/db/public-failure";
import {
  normalizePublicGitHubBranch,
  normalizePublicGitHubUrl,
} from "@cloud-swe/db/repository-url";
import { z } from "zod";

import { createContext, type AuthProvider, type AuthSession } from "../context";
import { logFailure, sendError } from "../http";
import { consumeThreadEventStream, type EventStreamItem, writeFrame } from "../server-events";
import { checkMutationSecurity, hasRequestBody, readHeader } from "../security";

declare module "fastify" {
  interface FastifyRequest {
    threadUserId: string | null;
    threadSession: AuthSession | null;
  }
}

const promptFields = {
  prompt: z.string().trim().min(1).max(100_000),
  clientMessageId: z.string().min(1).max(255),
};

const publicRepositoryUrl = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    const normalized = normalizePublicGitHubUrl(value);

    if (!normalized) {
      context.addIssue({ code: "custom", message: "Only public HTTPS GitHub URLs are supported" });

      return z.NEVER;
    }

    return normalized;
  });

const publicRepositoryBranch = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .transform((value, context) => {
    const normalized = normalizePublicGitHubBranch(value);

    if (!normalized) {
      context.addIssue({ code: "custom", message: "Invalid GitHub branch name" });

      return z.NEVER;
    }

    return normalized;
  });

const initialPromptBody = z
  .object({
    ...promptFields,
    repositoryUrl: publicRepositoryUrl.optional(),
    branch: publicRepositoryBranch.optional(),
  })
  .superRefine((body, context) => {
    if (body.branch && !body.repositoryUrl)
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "branch requires repositoryUrl",
      });
  })
  .strict();

const followupPromptBody = z.object(promptFields).strict();

const idParam = z.object({ id: z.uuid() });

const runParam = idParam.extend({ runId: z.uuid() });

const cursor = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(2_147_483_647));

export interface ThreadRouteStore {
  submitThread(input: SubmitInput): Promise<SubmitResult>;
  submitMessage(input: MessageInput): Promise<SubmitResult>;
  getThread(input: { userId: string; threadId: string }): Promise<ThreadView>;
  authorizeThread(input: { userId: string; threadId: string }): Promise<void>;
  listEvents(input: { threadId: string; after?: number; limit?: number }): Promise<ThreadEvent[]>;
  requestCancel(input: { userId: string; threadId: string; runId: string }): Promise<void>;
}

export interface ThreadRateLimitOptions {
  max: number;
  windowMs: number;
  maxEntries?: number;
}

export interface ThreadRouteOptions {
  store: ThreadRouteStore;
  auth: AuthProvider;
  trustedOrigins: readonly string[];
  runLimit?: number;
  pollMs?: number;
  heartbeatMs?: number;
  nodeEnv?: "development" | "test" | "production";
  allowUnverifiedCompute?: boolean;
  isTrustedComputeUser?: (userId: string) => Promise<boolean>;
  rateLimit?: ThreadRateLimitOptions;
  isOwner?: (userId: string) => Promise<boolean>;
}

type RateBucket = {
  count: number;
  windowStartedAt: number;
};

class UserRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(options: ThreadRateLimitOptions) {
    this.max = Math.max(1, Math.floor(options.max));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 10_000));
  }

  consume(userId: string, now = Date.now()): number | null {
    const current = this.buckets.get(userId);

    if (current && now - current.windowStartedAt < this.windowMs) {
      if (current.count >= this.max) return current.windowStartedAt + this.windowMs - now;
      current.count += 1;
      this.buckets.delete(userId);
      this.buckets.set(userId, current);

      return null;
    }

    if (this.buckets.size >= this.maxEntries) {
      const oldest = this.buckets.keys().next().value;

      if (oldest !== undefined) this.buckets.delete(oldest);
    }

    this.buckets.set(userId, { count: 1, windowStartedAt: now });

    return null;
  }
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

async function isComputeAdmitted(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ThreadRouteOptions,
): Promise<boolean> {
  const session = request.threadSession;

  if (!session) return false;

  if (
    options.nodeEnv !== undefined &&
    options.nodeEnv !== "production" &&
    options.allowUnverifiedCompute === true
  )
    return true;

  if (options.isTrustedComputeUser) {
    try {
      if (await options.isTrustedComputeUser(session.user.id)) return true;
    } catch (error) {
      logFailure(request, error, "Compute admission check failed");
      sendError(
        reply,
        503,
        "ADMISSION_UNAVAILABLE",
        "Compute admission is temporarily unavailable",
      );

      return false;
    }
  }

  sendError(
    reply,
    403,
    "COMPUTE_ADMISSION_REQUIRED",
    "Sign in with GitHub before starting a live-demo task",
  );

  return false;
}

async function admitSubmission(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ThreadRouteOptions,
  limiter: UserRateLimiter,
  userId: string,
) {
  try {
    const retryAfterMs = (await options.isOwner?.(userId)) ? null : limiter.consume(userId);

    if (retryAfterMs !== null) {
      sendRateLimitError(reply, retryAfterMs);

      return false;
    }

    return await isComputeAdmitted(request, reply, options);
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
  app.addHook("preClose", async () => {
    for (const close of activeStreams) close();
  });

  app.register(async (routes) => {
    routes.decorateRequest("threadUserId", null);
    routes.decorateRequest("threadSession", null);
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

      request.threadSession = session;
      request.threadUserId = session?.user.id ?? null;

      if (!request.threadUserId)
        return sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
    });

    routes.post("/api/threads", async (request, reply) => {
      const userId = request.threadUserId;

      if (!userId) return;
      const body = initialPromptBody.safeParse(request.body);

      if (!body.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid thread payload");

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

        let batch: ThreadEvent[];

        try {
          await options.store.authorizeThread({ threadId: params.data.id, userId });
          batch = await options.store.listEvents({
            threadId: params.data.id,
            after: parsedCursor.data,
            limit: 100,
          });
        } catch (error) {
          return storeError(request, reply, error);
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
        const abort = new AbortController();

        const close = () => {
          abort.abort();
          activeStreams.delete(close);

          // Destroy also releases a write waiting for a slow client to drain.
          if (!reply.raw.destroyed) reply.raw.destroy();
        };

        activeStreams.add(close);
        reply.raw.once("close", close);
        reply.raw.once("error", close);

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
