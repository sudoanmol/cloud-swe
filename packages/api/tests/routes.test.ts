import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";

import type { AuthProvider, AuthSession } from "../src/context";
import { registerApiRoutes } from "../src/routes";
import type { ThreadRouteStore, ThreadRouteOptions } from "../src/routers/thread";
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
    renameThread: async () => undefined,
    updatePendingMessage: async () => undefined,
    startQueuedMessage: async () => {
      throw new Error("unused");
    },
    deleteThread: async () => undefined,
    answerQuestionRequest: async () => {
      throw new Error("unused");
    },
  };

  return store;
}

async function createApp(
  options: {
    store?: ThreadRouteStore;
    browser?: ThreadRouteOptions["browser"];
    session?: AuthSession | null;
    authHandler?: AuthProvider["handler"];
    nodeEnv?: "development" | "test" | "production";
    allowUnverifiedCompute?: boolean;
    computeAccess?: (userId: string) => Promise<boolean>;
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
    browser: options.browser,
    trustedOrigins: [origin],
    nodeEnv: options.nodeEnv ?? "test",
    allowUnverifiedCompute: options.allowUnverifiedCompute ?? true,
    computeAccess: options.computeAccess,
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

  test("accepts an allowlisted GitHub account for production compute admission", async () => {
    let submitted = false;

    const app = await createApp({
      nodeEnv: "production",
      session: { user: { id: "github-user", emailVerified: false }, session: {} },
      computeAccess: async (userId) => userId === "github-user",
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

  test("queued starts enforce current compute access and fail closed on policy errors", async () => {
    let policy: "allowed" | "revoked" | "unavailable" = "allowed";
    let starts = 0;
    const threadId = randomUUID();
    const messageId = randomUUID();
    const result = { threadId, runId: randomUUID(), messageId, delivery: "run" as const };

    const app = await createApp({
      nodeEnv: "production",
      computeAccess: async () => {
        if (policy === "unavailable") throw new Error("Policy unavailable");

        return policy === "allowed";
      },
      store: {
        ...createStore(),
        startQueuedMessage: async () => {
          starts += 1;

          return result;
        },
      },
    });

    const start = () =>
      app.inject({
        method: "POST",
        url: `/api/threads/${threadId}/messages/${messageId}/start`,
        headers: { origin, "x-csrf-protection": "1" },
      });

    try {
      const started = await start();
      expect(started.statusCode).toBe(202);
      expect(started.json<unknown>()).toEqual(result);
      policy = "revoked";
      const denied = await start();
      expect(denied.statusCode).toBe(403);
      expect(starts).toBe(1);
      policy = "unavailable";
      expect((await start()).statusCode).toBe(503);
      expect(starts).toBe(1);
    } finally {
      await app.close();
    }
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
    repositoryUrl: null,
    repositoryBranch: null,
    diffStat: null,
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
    expect(calls[1]?.before).toEqual({ id: summaries[0]!.id, updatedAt: summaries[0]!.updatedAt });
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
    browserHandoff: false,
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

test("workspace ports list preview URLs for listening ports, except the forwarder", async () => {
  const threadId = randomUUID();
  const slug = "0123456789abcdef0123456789abcdef";

  const workspace = {
    readRepository: async () => ({ repositoryUrl: null, repositoryBranch: "main" }),
    readWorkspace: async () => ({
      state: "running",
      lifecycleTransitionId: null,
      provider: "modal",
      providerId: "sb-1",
      generation: 1,
    }),
    requestWorkspaceWake: async () => "not-paused" as const,
    touchWorkspaceReview: async () => undefined,
    recordDiffStat: async () => undefined,
    readPreviewSlug: async () => slug,
  };

  const build = async (previewDomain?: string) => {
    const app = Fastify({ logger: false });
    registerApiRoutes(app, {
      auth: {
        getSession: async () => ({ user: { id: "user-1", emailVerified: true }, session: {} }),
        handler: async () => Response.json({ ok: true }),
      },
      store: createStore(),
      trustedOrigins: [origin],
      nodeEnv: "test",
      allowUnverifiedCompute: true,
      pollMs: 10,
      heartbeatMs: 100,
      workspace: {
        // SAFETY: the route reads only the fields set above.
        store: workspace as never,
        previewDomain,
        run: async (_providerId, args) => {
          expect(args).toEqual(["ports"]);

          return JSON.stringify({ ok: true, result: [3000, 5432, 7999] });
        },
      },
    });
    await app.ready();

    return app;
  };

  const app = await build("p.example.test");
  const response = await app.inject({ url: `/api/threads/${threadId}/workspace/ports` });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    ports: [
      { port: 3000, url: `https://3000-${slug}.p.example.test` },
      { port: 5432, url: `https://5432-${slug}.p.example.test` },
    ],
  });
  await app.close();

  const disabled = await build();
  const unavailable = await disabled.inject({ url: `/api/threads/${threadId}/workspace/ports` });

  expect(unavailable.statusCode).toBe(503);
  expect(JSON.parse(unavailable.body).error.code).toBe("PREVIEWS_UNAVAILABLE");
  await disabled.close();
});

test("disabled browsers have no control route and report disabled features", async () => {
  const app = await createApp();

  try {
    expect(
      JSON.parse((await app.inject({ method: "GET", url: "/api/workspace-features" })).body),
    ).toEqual({ previews: false, browser: false });
    expect(
      (await app.inject({ method: "GET", url: `/api/threads/${randomUUID()}/browser` })).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});

test("browser reads authorize before provider access and control requires CSRF", async () => {
  const threadId = randomUUID();
  const reads: string[] = [];
  const changes: string[] = [];

  const app = await createApp({
    browser: {
      store: {
        readWorkspace: async () => null,
        readRepository: async ({ threadId: id }) => {
          if (id !== threadId)
            throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

          return { repositoryUrl: null, repositoryBranch: null, branchSuggestion: null };
        },
        readBrowserOwner: async () => "user",
        changeBrowserOwner: async ({ owner }) => {
          changes.push(owner);
        },
        touchWorkspaceReview: async (id) => {
          reads.push(id);
        },
      },
      browsers: {
        ensure: async () => {
          throw new Error("An existing browser must be reused");
        },
        find: async (id) => {
          reads.push(id);

          return { cdpUrl: "wss://private", liveViewUrl: "https://kernel.test/live" };
        },
      },
    },
  });

  try {
    expect(
      (await app.inject({ method: "GET", url: `/api/threads/${randomUUID()}/browser` })).statusCode,
    ).toBe(404);
    expect(reads).toEqual([]);
    const read = await app.inject({ method: "GET", url: `/api/threads/${threadId}/browser` });
    expect(JSON.parse(read.body)).toEqual({
      owner: "user",
      liveViewUrl: "https://kernel.test/live",
    });
    expect(reads).toEqual([threadId, threadId]);

    const request = {
      method: "POST" as const,
      url: `/api/threads/${threadId}/browser/control`,
      payload: { owner: "agent" },
    };

    expect((await app.inject(request)).statusCode).toBe(403);
    expect(changes).toEqual([]);
    expect(
      (await app.inject({ ...request, headers: { origin, "x-csrf-protection": "1" } })).statusCode,
    ).toBe(200);
    expect(changes).toEqual(["agent"]);
  } finally {
    await app.close();
  }
});

test("a user-controlled browser can be recreated after wake without answering the handoff", async () => {
  const threadId = randomUUID();
  let running = false;
  let owner: "agent" | "user" = "user";
  let created = 0;

  const app = await createApp({
    browser: {
      store: {
        readRepository: async () => ({
          repositoryUrl: null,
          repositoryBranch: null,
          branchSuggestion: null,
        }),
        // SAFETY: reachableSandbox reads only these workspace fields.
        readWorkspace: async () =>
          ({
            state: running ? "running" : "paused",
            provider: "modal",
            providerId: "sb-1",
            generation: 1,
            lifecycleTransitionId: null,
          }) as never,
        readBrowserOwner: async () => owner,
        changeBrowserOwner: async () => {
          throw new Error("Reading must not answer the handoff");
        },
        touchWorkspaceReview: async () => undefined,
      },
      browsers: {
        find: async () => null,
        ensure: async () => {
          created += 1;

          return { cdpUrl: "wss://private", liveViewUrl: "https://kernel.test/live" };
        },
      },
    },
  });

  try {
    const read = () => app.inject({ url: `/api/threads/${threadId}/browser` });
    expect(JSON.parse((await read()).body).liveViewUrl).toBeNull();
    expect(created).toBe(0);
    running = true;
    expect(JSON.parse((await read()).body)).toEqual({
      owner: "user",
      liveViewUrl: "https://kernel.test/live",
    });
    expect(created).toBe(1);
    owner = "agent";
    await read();
    expect(created).toBe(1);
  } finally {
    await app.close();
  }
});

test("the skill catalog read is owned and works without starting a paused workspace", async () => {
  const threadId = randomUUID();
  let allowed = true;

  const skills = [
    {
      name: "project",
      description: "Project workflow",
      path: "/workspace/.agents/skills/project/SKILL.md",
    },
  ];

  const app = Fastify();
  registerApiRoutes(app, {
    auth: {
      getSession: async () => ({ user: { id: "user-1" }, session: {} }),
      handler: async () => Response.json({}),
    },
    store: createStore(),
    trustedOrigins: [origin],
    pollMs: 10,
    heartbeatMs: 100,
    workspace: {
      store: {
        readRepository: async ({ userId, threadId: id }) => {
          expect(userId).toBe("user-1");
          expect(id).toBe(threadId);

          if (!allowed) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);

          return { repositoryUrl: null, repositoryBranch: null, branchSuggestion: null };
        },
        readSkills: async () => skills,
        readWorkspace: async () => {
          throw new Error("Must not access sandbox");
        },
        requestWorkspaceWake: async () => {
          throw new Error("Must not wake sandbox");
        },
        touchWorkspaceReview: async () => {
          throw new Error("Must not extend idle timer");
        },
        recordDiffStat: async () => undefined,
        readPreviewSlug: async () => null,
      },
    },
  });

  try {
    const response = await app.inject({ url: `/api/threads/${threadId}/workspace/skills` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ skills });
    allowed = false;
    expect(
      (await app.inject({ url: `/api/threads/${threadId}/workspace/skills` })).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
