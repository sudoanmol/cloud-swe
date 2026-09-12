import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listProviderModels,
  modelProviders,
  modelProviderSchema,
} from "@cloud-swe/db/model-selection";
import type { createModelCredentialStore } from "@cloud-swe/db/model-credentials";
import { sendError, sendFailure } from "../http";
import { UserRateLimiter } from "../security";

export type ModelCredentials = (userId: string) => ReturnType<typeof createModelCredentialStore>;

const apiKeyBody = z.object({ apiKey: z.string().trim().min(1).max(16384) }).strict();

const providerParams = z.object({ provider: modelProviderSchema });

const loginParams = z.object({ id: z.uuid() });

type LoginStatus =
  | {
      status: "pending";
      userCode: string;
      verificationUri: string;
      intervalSeconds: number;
      expiresAt: string;
    }
  | { status: "starting" | "authorized" | "failed" | "expired" };

/** Registered inside the authenticated, CSRF-protected thread route scope. */
export function registerModelRoutes(routes: FastifyInstance, credentialsFor?: ModelCredentials) {
  const limiter = new UserRateLimiter({ max: 5, windowMs: 60_000 });

  // ponytail: pending device logins are process-local; restart asks the user to start again.
  type Login = {
    id: string;
    startedAt: number;
    controller: AbortController;
    status: LoginStatus;
    timer: ReturnType<typeof setTimeout>;
  };

  const logins = new Map<string, Login>();

  function cancelLogin(userId: string) {
    const login = logins.get(userId);

    if (!login) return;
    login.controller.abort();
    clearTimeout(login.timer);
    logins.delete(userId);
  }

  routes.addHook("onClose", async () => {
    for (const userId of logins.keys()) cancelLogin(userId);
  });

  routes.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");

    return payload;
  });

  routes.get("/api/model-providers", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;

    try {
      const saved = credentialsFor ? await credentialsFor(userId).list() : [];

      return {
        providers: modelProviders.map((provider) => ({
          id: provider.id,
          name: provider.name,
          authType: provider.id === "openai-codex" ? "oauth" : "api_key",
          connected: saved.some((entry) => entry.providerId === provider.id),
        })),
      };
    } catch (error) {
      return sendFailure(request, reply, error);
    }
  });

  routes.get("/api/model-providers/:provider/models", async (request, reply) => {
    const params = providerParams.safeParse(request.params);

    if (!params.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid model provider");

    return { source: "pi-ai", version: "0.85.1", models: listProviderModels(params.data.provider) };
  });

  routes.put("/api/model-providers/:provider/credentials", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;
    const params = providerParams.safeParse(request.params);
    const body = apiKeyBody.safeParse(request.body);

    if (!params.success || !body.success || params.data.provider === "openai-codex")
      return sendError(
        reply,
        400,
        "INVALID_PAYLOAD",
        "Use an API key provider or start ChatGPT device login",
      );

    if (!credentialsFor)
      return sendError(
        reply,
        503,
        "MODEL_BROKER_UNAVAILABLE",
        "Model credential storage is not configured",
      );

    try {
      await credentialsFor(userId).modify(params.data.provider, async () => ({
        type: "api_key",
        key: body.data.apiKey,
      }));

      return reply.status(204).send();
    } catch (error) {
      return sendFailure(request, reply, error);
    }
  });

  routes.delete("/api/model-providers/:provider/credentials", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;
    const params = providerParams.safeParse(request.params);

    if (!params.success) return sendError(reply, 400, "INVALID_PAYLOAD", "Invalid model provider");

    if (!credentialsFor)
      return sendError(
        reply,
        503,
        "MODEL_BROKER_UNAVAILABLE",
        "Model credential storage is not configured",
      );

    if (params.data.provider === "openai-codex") cancelLogin(userId);

    try {
      await credentialsFor(userId).delete(params.data.provider);

      return reply.status(204).send();
    } catch (error) {
      return sendFailure(request, reply, error);
    }
  });

  routes.post("/api/model-providers/openai-codex/device-login", async (request, reply) => {
    const userId = request.threadUserId;

    if (!userId) return;

    if (!credentialsFor)
      return sendError(
        reply,
        503,
        "MODEL_BROKER_UNAVAILABLE",
        "Model credential storage is not configured",
      );
    const previous = logins.get(userId);

    if (
      previous &&
      (previous.status.status === "pending" || Date.now() - previous.startedAt < 60_000)
    )
      return reply.status(202).send({ id: previous.id, ...previous.status });

    if (limiter.consume(userId) !== null)
      return sendError(reply, 429, "RATE_LIMITED", "Too many device login attempts");
    cancelLogin(userId);

    if (logins.size >= 1000) return sendError(reply, 429, "RATE_LIMITED", "Too many device logins");
    const oauth = modelProviders.find((provider) => provider.id === "openai-codex")?.auth.oauth;

    if (!oauth)
      return sendError(reply, 503, "MODEL_BROKER_UNAVAILABLE", "ChatGPT login is unavailable");
    const controller = new AbortController();

    const login: Login = {
      id: randomUUID(),
      startedAt: Date.now(),
      controller,
      status: { status: "starting" },
      timer: setTimeout(() => cancelLogin(userId), 16 * 60_000),
    };

    login.timer.unref();
    logins.set(userId, login);
    const ready = Promise.withResolvers<void>();
    const setupTimeout = setTimeout(() => controller.abort(), 30_000);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);

    // The library owns device-code polling, PKCE exchange, and token decoding.
    void oauth
      .login({
        signal,
        prompt: async (prompt) => {
          if (
            prompt.type === "select" &&
            prompt.options.some((option) => option.id === "device_code")
          )
            return "device_code";
          throw new Error("Unexpected ChatGPT login prompt");
        },
        notify: (event) => {
          if (event.type !== "device_code") return;
          clearTimeout(setupTimeout);
          login.status = {
            status: "pending",
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            intervalSeconds: event.intervalSeconds ?? 5,
            expiresAt: new Date(
              login.startedAt + (event.expiresInSeconds ?? 900) * 1000,
            ).toISOString(),
          };
          ready.resolve();
        },
      })
      .then(async (credential) => {
        await credentialsFor(userId).modify("openai-codex", async () => credential, { signal });
        login.status = { status: "authorized" };
      })
      .catch(() => {
        // SDK errors can embed tokens or upstream response bodies. Never return or log them.
        login.status = { status: signal.aborted ? "expired" : "failed" };
      })
      .finally(() => {
        clearTimeout(setupTimeout);
        ready.resolve();
      });
    await ready.promise;

    return reply.status(202).send({ id: login.id, ...login.status });
  });

  routes.get("/api/model-providers/openai-codex/device-login/:id", async (request, reply) => {
    const params = loginParams.safeParse(request.params);
    const login = request.threadUserId ? logins.get(request.threadUserId) : undefined;

    if (!params.success || !login || login.id !== params.data.id)
      return sendError(reply, 404, "LOGIN_NOT_FOUND", "Device login not found or expired");

    return { id: login.id, ...login.status };
  });
}
