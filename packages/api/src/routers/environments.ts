import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { envSetNameSchema, parseEnvText, type EnvSetStore } from "@cloud-swe/db/env-sets";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";
import { sendError, sendFailure } from "../http";

export type EnvironmentRouteOptions = { store: EnvSetStore };

const idParam = z.object({ id: z.uuid() });

// Names are validated by the store, so its errors can name the variable.
const entry = z.object({
  name: z.string().max(256),
  secret: z.boolean(),
  value: z.string().max(65_536),
});

const createBody = z.union([
  z.object({ name: envSetNameSchema, entries: z.array(entry).max(200) }).strict(),
  z.object({ name: envSetNameSchema, dotenv: z.string().max(131_072) }).strict(),
]);

const updateBody = z
  .object({
    name: envSetNameSchema.optional(),
    entries: z
      .array(
        entry.extend({
          value: entry.shape.value.optional(),
          previousName: z.string().max(256).optional(),
        }),
      )
      .max(200),
  })
  .strict();

/** Validation messages name the variable, never its value, so they can reach the user. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught store failures are projected to a bounded response.
function fail(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof ThreadStoreError && error.code === "INVALID_ENVIRONMENT")
    return sendError(reply, 400, error.code, error.message);

  return sendFailure(request, reply, error);
}

const threadBody = z.object({ environmentId: z.uuid().nullable() }).strict();

/**
 * Registered inside the authenticated, CSRF-protected thread route scope.
 * Responses carry names and secret flags only; values are write-only. Never log bodies.
 */
export function registerEnvironmentRoutes(
  routes: FastifyInstance,
  options: EnvironmentRouteOptions,
) {
  const { store } = options;

  routes.get("/api/environments", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;

    try {
      return { environments: await store.list(userId) };
    } catch (error) {
      return fail(request, reply, error);
    }
  });

  routes.post("/api/environments", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;
    const body = createBody.safeParse(request.body);

    if (!body.success)
      return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid environment payload");

    try {
      const entries = "dotenv" in body.data ? parseEnvText(body.data.dotenv) : body.data.entries;
      const created = await store.create({ userId, name: body.data.name, entries });

      return reply.status(201).send(created);
    } catch (error) {
      return fail(request, reply, error);
    }
  });

  routes.put("/api/environments/:id", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;
    const params = idParam.safeParse(request.params);
    const body = updateBody.safeParse(request.body);

    if (!params.success || !body.success)
      return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid environment payload");

    try {
      return await store.update({ userId, id: params.data.id, ...body.data });
    } catch (error) {
      return fail(request, reply, error);
    }
  });

  routes.delete("/api/environments/:id", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;
    const params = idParam.safeParse(request.params);

    if (!params.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid environment id");

    try {
      await store.remove({ userId, id: params.data.id });

      return reply.status(204).send();
    } catch (error) {
      return fail(request, reply, error);
    }
  });

  routes.put("/api/threads/:id/environment", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;
    const params = idParam.safeParse(request.params);
    const body = threadBody.safeParse(request.body);

    if (!params.success || !body.success)
      return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid thread environment payload");

    try {
      await store.setThreadEnvSet({
        userId,
        threadId: params.data.id,
        envSetId: body.data.environmentId,
      });

      return reply.status(204).send();
    } catch (error) {
      return fail(request, reply, error);
    }
  });
}
