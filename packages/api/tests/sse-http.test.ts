import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthProvider } from "../src/context";
import { registerApiRoutes } from "../src/routes";
import type { ThreadRouteStore } from "../src/routers/thread";
import type { ThreadEvent } from "@cloud-swe/db/thread-contracts";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";

const origin = "http://127.0.0.1:3001";

function event(sequence: number): ThreadEvent {
  return {
    id: randomUUID(),
    sequence,
    type: "run.queued",
    payload: {},
    dedupeKey: `run.queued:${sequence}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function baseStore(overrides: Partial<ThreadRouteStore> = {}): ThreadRouteStore {
  return {
    listThreads: async () => [],
    submitThread: async () => ({ threadId: randomUUID(), runId: randomUUID() }),
    submitMessage: async () => ({ threadId: randomUUID(), runId: randomUUID() }),
    getThread: async () => {
      throw new Error("unused");
    },
    authorizeThread: async () => undefined,
    listEvents: async () => [],
    requestCancel: async () => undefined,
    ...overrides,
  };
}

async function listen(
  store: ThreadRouteStore,
  options: {
    auth?: AuthProvider;
    logger?: boolean;
    captureReply?: (request: FastifyRequest, reply: FastifyReply) => void;
  } = {},
) {
  const logStream = new PassThrough();
  const logLines: string[] = [];
  logStream.on("data", (chunk: Buffer) => logLines.push(chunk.toString()));

  const app = Fastify({
    logger: options.logger === false ? false : { stream: logStream },
  });

  if (options.captureReply)
    app.addHook("preHandler", async (request, reply) => {
      options.captureReply?.(request, reply);
    });

  const auth =
    options.auth ??
    ({
      getSession: async () => ({ user: { id: "user-1", emailVerified: true }, session: {} }),
      handler: async () => Response.json({ ok: true }),
    } satisfies AuthProvider);

  registerApiRoutes(app, {
    auth,
    store,
    trustedOrigins: [origin],
    nodeEnv: "test",
    allowUnverifiedCompute: true,
    pollMs: 5,
    heartbeatMs: 100,
    rateLimit: { max: 100, windowMs: 60_000 },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();

  const bound = z.object({ port: z.number() }).parse(address);

  return { app, baseUrl: `http://127.0.0.1:${bound.port}`, logLines };
}

const headers = { origin };

test("SSE limits concurrent readers and releases capacity after failure or disconnect", async () => {
  let reject = true;

  const { app, baseUrl } = await listen(
    baseStore({
      authorizeThread: async () => {
        if (reject) throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
      },
    }),
  );

  const url = `${baseUrl}/api/threads/${randomUUID()}/events`;
  const controllers: AbortController[] = [];

  try {
    for (let index = 0; index < 6; index++)
      expect((await fetch(url, { headers })).status).toBe(404);
    reject = false;

    for (let index = 0; index < 5; index++) {
      const controller = new AbortController();
      controllers.push(controller);
      expect((await fetch(url, { headers, signal: controller.signal })).status).toBe(200);
    }

    expect((await fetch(url, { headers })).status).toBe(429);
    controllers[0]!.abort();
    const replacement = new AbortController();
    controllers.push(replacement);
    let status = 429;
    const deadline = Date.now() + 1000;

    while (status === 429 && Date.now() < deadline) {
      await Bun.sleep(5);
      status = (await fetch(url, { headers, signal: replacement.signal })).status;
    }

    expect(status).toBe(200);
  } finally {
    for (const controller of controllers) controller.abort();
    await app.close();
  }
});

describe("SSE HTTP lifecycle", () => {
  test("performs authorization and the first read before committing SSE headers", async () => {
    let listed = false;

    const { app, baseUrl } = await listen(
      baseStore({
        authorizeThread: async () => {
          throw new ThreadStoreError("THREAD_NOT_FOUND", "Thread not found", 404);
        },
        listEvents: async () => {
          listed = true;

          return [];
        },
      }),
    );

    try {
      const response = await fetch(`${baseUrl}/api/threads/${randomUUID()}/events`, { headers });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).not.toContain("text/event-stream");
      expect(listed).toBe(false);
    } finally {
      await app.close();
    }
  });

  test("returns an initial database failure as HTTP before headers", async () => {
    const secret = "Bearer PREHEADER basic PREBASIC Cookie=a=COOKIE_A; b=COOKIE_B";

    const { app, baseUrl } = await listen(
      baseStore({
        listEvents: async () => {
          throw new ThreadStoreError("DB_FAILURE", secret, 500);
        },
      }),
    );

    try {
      const response = await fetch(`${baseUrl}/api/threads/${randomUUID()}/events`, { headers });
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).not.toContain("text/event-stream");
      expect(body).toContain('"INTERNAL_ERROR"');
      expect(body).not.toContain("PREHEADER");
    } finally {
      await app.close();
    }
  });

  test("gives the query cursor precedence over Last-Event-ID", async () => {
    let firstAfter: number | undefined;

    const { app, baseUrl } = await listen(
      baseStore({
        listEvents: async ({ after }) => {
          if (firstAfter === undefined) {
            firstAfter = after;

            return [event(4)];
          }

          return [];
        },
      }),
    );

    try {
      const response = await fetch(`${baseUrl}/api/threads/${randomUUID()}/events?after=3`, {
        headers: { ...headers, "last-event-id": "7" },
      });

      const reader = response.body?.getReader();

      expect(response.status).toBe(200);
      expect(reader).toBeDefined();
      const first = await reader?.read();

      expect(new TextDecoder().decode(first?.value)).toContain("id: 4");
      expect(firstAfter).toBe(3);
      await reader?.cancel();
    } finally {
      await app.close();
    }
  });

  test("closes a reader during server shutdown", async () => {
    const { app, baseUrl } = await listen(baseStore());
    const response = await fetch(`${baseUrl}/api/threads/${randomUUID()}/events`, { headers });
    const reader = response.body?.getReader();

    expect(response.status).toBe(200);
    expect(reader).toBeDefined();
    await app.close();

    const result = await reader?.read().catch(() => ({ done: true, value: undefined }));

    expect(result?.done).toBe(true);
  });

  test("logs a bounded classification when polling fails after headers", async () => {
    const secret =
      'Authorization: Bearer BEARER_SECRET\nAuthorization: Basic BASIC_SECRET\nCookie: a="COOKIE_A"; b=COOKIE_B\nhttps://URL_USER:URL_PASS@example.test/path';

    const nested = new Error(secret);
    const failure = new Error(secret, { cause: nested });
    let calls = 0;

    const { app, baseUrl, logLines } = await listen(
      baseStore({
        listEvents: async () => {
          calls += 1;

          if (calls === 1) return [];
          throw failure;
        },
      }),
    );

    try {
      const response = await fetch(`${baseUrl}/api/threads/${randomUUID()}/events`, { headers });
      const body = await response.text().catch(() => "");

      expect(response.status).toBe(200);
      expect(calls).toBeGreaterThan(1);
      expect(body).toBe("");
      const logs = logLines.join("");

      expect(logs).toContain("SSE event polling failed");
      expect(logs).toContain("INTERNAL_ERROR");

      for (const value of [
        "BEARER_SECRET",
        "BASIC_SECRET",
        "COOKIE_A",
        "COOKIE_B",
        "URL_USER",
        "URL_PASS",
      ]) {
        expect(logs).not.toContain(value);
      }
    } finally {
      await app.close();
    }
  });

  test("aborts a blocked poll when the response socket errors", async () => {
    let reply: FastifyReply | undefined;
    let calls = 0;
    const pollStarted = Promise.withResolvers<void>();
    const blockedPoll = Promise.withResolvers<ThreadEvent[]>();

    const { app, baseUrl } = await listen(
      baseStore({
        listEvents: async () => {
          calls += 1;

          if (calls === 1) return [event(1)];

          pollStarted.resolve();

          return blockedPoll.promise;
        },
      }),
      {
        captureReply: (_request, captured) => {
          reply = captured;
        },
      },
    );

    try {
      const response = await fetch(`${baseUrl}/api/threads/${randomUUID()}/events`, { headers });
      const reader = response.body?.getReader();

      expect(response.status).toBe(200);
      expect(reader).toBeDefined();
      await reader?.read();
      await pollStarted.promise;
      expect(reply).toBeDefined();

      reply?.raw.emit("error", new Error("socket failed"));

      const result = await Promise.race([
        reader?.read().catch(() => ({ done: true, value: undefined })),
        new Promise<{ done: boolean }>((resolve) =>
          setTimeout(() => resolve({ done: false }), 1_000),
        ),
      ]);

      expect(result?.done).toBe(true);
      expect(calls).toBe(2);
    } finally {
      blockedPoll.resolve([]);
      await app.close();
    }
  });

  test("logs bounded authentication failures without credential text", async () => {
    const secret =
      "Bearer AUTH_BEARER; Cookie: a=AUTH_COOKIE; https://AUTH_USER:AUTH_PASS@example.test";

    const { app, baseUrl, logLines } = await listen(baseStore(), {
      auth: {
        getSession: async () => {
          throw new Error(secret, { cause: new Error(secret) });
        },
        handler: async () => Response.json({ ok: true }),
      },
    });

    try {
      const response = await fetch(`${baseUrl}/api/threads/${randomUUID()}`, { headers });
      const body = await response.text();
      const logs = logLines.join("");

      expect(response.status).toBe(503);
      expect(body).not.toContain("AUTH_BEARER");
      expect(logs).toContain("Authentication lookup failed");
      expect(logs).toContain("INTERNAL_ERROR");
      expect(logs).not.toContain("AUTH_BEARER");
      expect(logs).not.toContain("AUTH_COOKIE");
      expect(logs).not.toContain("AUTH_USER");
      expect(logs).not.toContain("AUTH_PASS");
    } finally {
      await app.close();
    }
  });
});

for (const phase of ["authorization", "first read"]) {
  for (const shutdown of [false, true]) {
    test(`SSE ${shutdown ? "shutdown" : "disconnect"} during ${phase} never starts polling`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;

      const block = async () => {
        entered.resolve();
        await release.promise;
      };

      const { app, baseUrl } = await listen(
        baseStore({
          authorizeThread: async () => {
            if (phase === "authorization") await block();
          },
          listEvents: async () => {
            reads++;

            if (phase === "first read" && reads === 1) await block();

            return [];
          },
        }),
      );

      const abort = new AbortController();

      const response = fetch(`${baseUrl}/api/threads/${randomUUID()}/events`, {
        headers,
        signal: abort.signal,
      }).catch(() => undefined);

      try {
        await entered.promise;
        let closed: Promise<void> | undefined;

        if (shutdown) closed = app.close();
        else abort.abort();
        await Bun.sleep(25);
        release.resolve();
        await response;

        if (closed) await closed;
        await Bun.sleep(40);
        expect(reads).toBe(phase === "authorization" ? 0 : 1);
      } finally {
        release.resolve();
        abort.abort();
        await app.close();
      }
    }, 5000);
  }
}
