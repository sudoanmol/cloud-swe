import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ThreadStore, ThreadEvent } from "@cloud-swe/db/thread-contracts";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";
import { createContext } from "@cloud-swe/api/context";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

declare module "fastify" {
  interface FastifyRequest {
    threadUserId: string | null;
  }
}

const promptBody = z
  .object({
    prompt: z.string().trim().min(1).max(100_000),
    clientMessageId: z.string().min(1).max(255),
  })
  .strict();
const idParam = z.object({ id: z.uuid() });
const runParam = idParam.extend({ runId: z.uuid() });
const cursor = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(2_147_483_647));

export interface ThreadApiOptions {
  store: ThreadStore;
  runLimit?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.status(statusCode).send({ error: { code, message } });
}

function storeError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof ThreadStoreError)
    return sendError(reply, error.statusCode, error.code, error.message);
  request.log.error({ err: error }, "Thread request failed");
  return sendError(reply, 500, "INTERNAL_ERROR", "Unable to process request");
}

// Wait for the socket to drain before reading another batch from PostgreSQL.
async function writeFrame(reply: FastifyReply, frame: string): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  if (reply.raw.write(frame)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      reply.raw.off("drain", done);
      reply.raw.off("close", done);
      reply.raw.off("error", done);
      resolve();
    };
    reply.raw.once("drain", done);
    reply.raw.once("close", done);
    reply.raw.once("error", done);
  });
}

function eventFrame(event: ThreadEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export function registerThreadApi(app: FastifyInstance, options: ThreadApiOptions) {
  const runLimit = options.runLimit ?? 2;
  const pollMs = options.pollMs ?? 200;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const activeStreams = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const close of activeStreams) close();
  });

  app.register(async (routes) => {
    routes.decorateRequest("threadUserId", null);
    routes.addHook("preHandler", async (request, reply) => {
      const context = await createContext(request.headers);
      request.threadUserId = context.session?.user.id ?? null;
      if (!request.threadUserId)
        return sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
    });

    routes.post("/api/threads", async (request, reply) => {
      const userId = request.threadUserId;
      if (!userId) return;
      const body = promptBody.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid thread payload");
      try {
        const result = await options.store.submitThread({
          ...body.data,
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
      const body = promptBody.safeParse(request.body);
      if (!params.success || !body.success)
        return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid message payload");
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
          request.query.after ?? request.headers["last-event-id"] ?? "0",
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
          batch = await options.store.listEvents({
            threadId: params.data.id,
            userId,
            after: String(parsedCursor.data),
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
        let lastId = parsedCursor.data;
        let lastHeartbeat = Date.now();
        try {
          while (!abort.signal.aborted) {
            for (const event of batch) {
              if (abort.signal.aborted) break;
              await writeFrame(reply, eventFrame(event));
              lastId = event.sequence;
            }
            if (Date.now() - lastHeartbeat >= heartbeatMs) {
              await writeFrame(reply, ": heartbeat\n\n");
              lastHeartbeat = Date.now();
            }
            await delay(pollMs, undefined, { signal: abort.signal });
            batch = await options.store.listEvents({
              threadId: params.data.id,
              userId,
              after: String(lastId),
              limit: 100,
            });
          }
        } catch (error) {
          if (!abort.signal.aborted) request.log.error({ err: error }, "SSE event polling failed");
        } finally {
          reply.raw.off("close", close);
          close();
        }
      },
    );
  });
}
