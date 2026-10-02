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
    listThreads: async () => [],
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
    listQuestionRequests: async () => [],
    answerQuestionRequest: async () => {
      throw new Error("unused");
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
    computeAccess?: (userId: string) => Promise<{ owner: boolean; trusted: boolean }>;
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
    computeAccess: options.computeAccess,
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
      computeAccess: async (userId) => ({ trusted: userId === "github-user", owner: false }),
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
          throw new ThreadStoreError(
            "DATABASE_SECRET",
            "Bearer provider-secret basic dXNlcjpzZWNyZXQ= https://user:pass@example.test",
            500,
          );
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
    expect(response.body).not.toContain("provider-secret");
    expect(response.body).not.toContain("user:pass@example.test");
    await app.close();
  });
});

test("thread list validates cursors and passes authenticated identity with pagination", async () => {
  const store = createStore();
  const calls: Parameters<ThreadRouteStore["listThreads"]>[0][] = [];

  const summaries = Array.from({ length: 2 }, () => ({
    id: randomUUID(),
    title: "Thread",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    runStatus: "completed" as const,
    workspaceState: null,
  }));

  store.listThreads = async (input) => {
    calls.push(input);

    return summaries;
  };

  const app = await createApp({ store });

  try {
    const first = await app.inject({ url: "/api/threads?limit=1" });
    expect(first.statusCode).toBe(200);
    const page = JSON.parse(first.body);
    expect(page.threads).toHaveLength(1);
    expect(page.nextCursor).toBeString();
    await app.inject({ url: `/api/threads?limit=1&before=${page.nextCursor}` });
    expect(calls[0]).toEqual({ userId: "user-1", limit: 2, before: undefined });
    expect(calls[1]?.before).toEqual({ id: summaries[0]!.id, createdAt: summaries[0]!.createdAt });
    expect((await app.inject({ url: "/api/threads?before=invalid" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/threads?limit=101" })).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});

test("question routes list owned requests and validate complete answers", async () => {
  const store = createStore();
  const threadId = randomUUID();
  const requestId = randomUUID();

  const request = {
    id: requestId,
    runId: randomUUID(),
    threadId,
    userId: "user-1",
    toolCallId: "tool-call",
    questions: [{ id: "name", header: "Name", question: "What is the name?" }],
    state: "pending" as const,
    answers: null,
    createdAt: new Date(),
    answeredAt: null,
    cancelledAt: null,
  };

  const answers: Parameters<ThreadRouteStore["answerQuestionRequest"]>[0][] = [];
  store.listQuestionRequests = async (input) => {
    expect(input).toEqual({ userId: "user-1", threadId });

    return [request];
  };

  store.answerQuestionRequest = async (input) => {
    answers.push(input);

    return { ...request, state: "answered", answers: input.answers, answeredAt: new Date() };
  };

  const app = await createApp({ store });

  const headers = {
    origin,
    "x-csrf-protection": "1",
    "content-type": "application/json",
  };

  try {
    const listed = await app.inject({ url: `/api/threads/${threadId}/questions` });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).requests).toHaveLength(1);

    const invalid = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/questions/${requestId}/answer`,
      headers,
      payload: { answers: { name: " " } },
    });

    expect(invalid.statusCode).toBe(400);

    const answered = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/questions/${requestId}/answer`,
      headers,
      payload: { answers: { name: "Cloud SWE" } },
    });

    expect(answered.statusCode).toBe(200);
    expect(answers).toEqual([
      {
        userId: "user-1",
        threadId,
        requestId,
        answers: { name: "Cloud SWE" },
      },
    ]);
  } finally {
    await app.close();
  }
});

test("question answers keep CSRF and conflict protections", async () => {
  let called = false;
  const store = createStore();
  store.answerQuestionRequest = async () => {
    called = true;
    throw new ThreadStoreError(
      "QUESTION_ANSWER_CONFLICT",
      "This request already has different answers",
      409,
    );
  };

  const app = await createApp({ store });
  const url = `/api/threads/${randomUUID()}/questions/${randomUUID()}/answer`;

  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: {
            origin: "https://attacker.example.test",
            "x-csrf-protection": "1",
            "content-type": "application/json",
          },
          payload: { answers: { name: "value" } },
        })
      ).statusCode,
    ).toBe(403);
    expect(called).toBe(false);

    const conflict = await app.inject({
      method: "POST",
      url,
      headers: { origin, "x-csrf-protection": "1", "content-type": "application/json" },
      payload: { answers: { name: "value" } },
    });

    expect(conflict.statusCode).toBe(409);
  } finally {
    await app.close();
  }
});
