import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";

import type { AuthProvider, AuthSession } from "../src/context";
import { registerApiRoutes } from "../src/routes";
import type { ThreadRouteStore } from "../src/routers/thread";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";

const origin = "https://web.example.test";

function createStore(
  options: { onCancel?: () => void; submit?: ThreadRouteStore["submitThread"] } = {},
) {
  const store: ThreadRouteStore = {
    submitThread:
      options.submit ??
      (async () => ({
        threadId: randomUUID(),
        runId: randomUUID(),
      })),
    submitMessage: async () => ({ threadId: randomUUID(), runId: randomUUID() }),
    getThread: async () => {
      throw new Error("unused");
    },
    authorizeThread: async () => undefined,
    listEvents: async () => [],
    requestCancel: async () => {
      options.onCancel?.();
    },
  };

  return store;
}

async function createApp(
  options: {
    store?: ThreadRouteStore;
    session?: AuthSession | null;
    authHandler?: AuthProvider["handler"];
    nodeEnv?: "development" | "test" | "production";
    allowUnverifiedCompute?: boolean;
    isTrustedComputeUser?: (userId: string) => Promise<boolean>;
    rateLimit?: { max: number; windowMs: number; maxEntries?: number };
  } = {},
) {
  const session =
    options.session === undefined
      ? { user: { id: "user-1", emailVerified: true }, session: {} }
      : options.session;

  const auth: AuthProvider = {
    getSession: async () => session,
    handler: options.authHandler ?? (async () => Response.json({ ok: true })),
  };

  const app = Fastify({ logger: false });
  registerApiRoutes(app, {
    auth,
    store: options.store ?? createStore(),
    trustedOrigins: [origin],
    nodeEnv: options.nodeEnv ?? "test",
    allowUnverifiedCompute: options.allowUnverifiedCompute ?? true,
    isTrustedComputeUser: options.isTrustedComputeUser,
    rateLimit: options.rateLimit ?? { max: 100, windowMs: 60_000 },
    pollMs: 10,
    heartbeatMs: 100,
  });
  await app.ready();

  return app;
}

describe("canonical API security", () => {
  test("does not register the removed RPC or OpenAPI routes", async () => {
    const app = await createApp();

    expect((await app.inject({ method: "POST", url: "/rpc/healthCheck" })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api-reference/openapi.json" })).statusCode,
    ).toBe(404);
    await app.close();
  });

  test("rejects an untrusted cancellation without changing the active run", async () => {
    let active = true;
    let cancelCalls = 0;

    const app = await createApp({
      store: createStore({
        onCancel: () => {
          active = false;
          cancelCalls += 1;
        },
      }),
    });

    const threadId = randomUUID();
    const runId = randomUUID();

    const response = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/runs/${runId}/cancel`,
      headers: {
        origin: "https://attacker.example.test",
        "x-csrf-protection": "1",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(cancelCalls).toBe(0);
    expect(active).toBe(true);
    await app.close();
  });

  test("rejects a canonical mutation with no Origin header", async () => {
    let submitted = false;

    const app = await createApp({
      store: createStore({
        submit: async () => {
          submitted = true;

          return { threadId: randomUUID(), runId: randomUUID() };
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: {
        "x-csrf-protection": "1",
        "content-type": "application/json",
      },
      payload: { prompt: "start", clientMessageId: "message-1" },
    });

    expect(response.statusCode).toBe(403);
    expect(submitted).toBe(false);
    await app.close();
  });

  test("requires the custom CSRF header on canonical thread mutations", async () => {
    let submitted = false;

    const app = await createApp({
      store: createStore({
        submit: async () => {
          submitted = true;

          return { threadId: randomUUID(), runId: randomUUID() };
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: {
        origin,
        "content-type": "application/json",
      },
      payload: { prompt: "start", clientMessageId: "message-1" },
    });

    expect(response.statusCode).toBe(403);
    expect(submitted).toBe(false);
    await app.close();
  });

  test("does not add a custom header requirement to Better Auth mutations", async () => {
    let called = false;

    const app = await createApp({
      authHandler: async (request) => {
        called = request.headers.get("origin") === origin;

        return Response.json({ ok: true });
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: {
        origin,
        "content-type": "application/json",
      },
      payload: { email: "user@example.test", password: "password" },
    });

    expect(response.statusCode).toBe(200);
    expect(called).toBe(true);
    await app.close();
  });

  test("rejects an untrusted Better Auth mutation", async () => {
    let called = false;

    const app = await createApp({
      authHandler: async () => {
        called = true;

        return Response.json({ ok: true });
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: {
        origin: "https://attacker.example.test",
        "content-type": "application/json",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(called).toBe(false);
    await app.close();
  });

  test("rejects form bodies on Better Auth mutations", async () => {
    let called = false;

    const app = await createApp({
      authHandler: async () => {
        called = true;

        return Response.json({ ok: true });
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "email=user%40example.test&password=password",
    });

    expect(response.statusCode).toBe(415);
    expect(called).toBe(false);
    await app.close();
  });

  test("applies a bounded per-user submission rate limit", async () => {
    let submitted = 0;

    const app = await createApp({
      rateLimit: { max: 1, windowMs: 60_000, maxEntries: 1 },
      store: createStore({
        submit: async () => {
          submitted += 1;

          return { threadId: randomUUID(), runId: randomUUID() };
        },
      }),
    });

    const request = {
      method: "POST" as const,
      url: "/api/threads",
      headers: {
        origin,
        "x-csrf-protection": "1",
        "content-type": "application/json",
      },
      payload: { prompt: "start", clientMessageId: "message-1" },
    };

    expect((await app.inject(request)).statusCode).toBe(202);
    const limited = await app.inject(request);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(submitted).toBe(1);
    await app.close();
  });

  test("blocks unverified users from launching compute in production", async () => {
    let submitted = false;

    const app = await createApp({
      nodeEnv: "production",
      allowUnverifiedCompute: true,
      session: { user: { id: "unverified", emailVerified: false }, session: {} },
      store: createStore({
        submit: async () => {
          submitted = true;

          return { threadId: randomUUID(), runId: randomUUID() };
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: {
        origin,
        "x-csrf-protection": "1",
        "content-type": "application/json",
      },
      payload: { prompt: "start", clientMessageId: "message-1" },
    });

    expect(response.statusCode).toBe(403);
    expect(submitted).toBe(false);
    await app.close();
  });

  test("accepts a trusted GitHub account for production compute admission", async () => {
    let submitted = false;

    const app = await createApp({
      nodeEnv: "production",
      session: { user: { id: "github-user", emailVerified: false }, session: {} },
      isTrustedComputeUser: async (userId) => userId === "github-user",
      store: createStore({
        submit: async () => {
          submitted = true;

          return { threadId: randomUUID(), runId: randomUUID() };
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: {
        origin,
        "x-csrf-protection": "1",
        "content-type": "application/json",
      },
      payload: { prompt: "start", clientMessageId: "message-1" },
    });

    expect(response.statusCode).toBe(202);
    expect(submitted).toBe(true);
    await app.close();
  });

  test("hides internal store details from server errors", async () => {
    const app = await createApp({
      store: createStore({
        submit: async () => {
          throw new ThreadStoreError("DATABASE_SECRET", "connection details", 500);
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: {
        origin,
        "x-csrf-protection": "1",
        "content-type": "application/json",
      },
      payload: { prompt: "start", clientMessageId: "message-1" },
    });

    expect(response.statusCode).toBe(500);
    const payload: unknown = JSON.parse(response.body);
    expect(payload).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Unable to process request" },
    });
    await app.close();
  });
});
