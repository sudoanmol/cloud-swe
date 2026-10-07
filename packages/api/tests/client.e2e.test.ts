import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { z } from "zod";
import type { JsonObject } from "@cloud-swe/db/json";
import { randomUUID } from "node:crypto";

import { createApiTransport, parseChecked, ThreadApiError } from "../src/client";
import { cancelResultSchema, submitResultSchema, threadSnapshotSchema } from "../src/contracts";
import type { AuthSession } from "../src/context";
import { registerApiRoutes } from "../src/routes";
import type { ThreadRouteStore } from "../src/routers/thread";
import type { ThreadEvent, ThreadView } from "@cloud-swe/db/thread-contracts";

const origin = "http://127.0.0.1:3001";

function event(sequence: number, type: string, payload: JsonObject = {}): ThreadEvent {
  return {
    id: randomUUID(),
    sequence,
    type,
    payload,
    dedupeKey: `${type}:${sequence}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function createMemoryStore() {
  const threadId = randomUUID();
  const firstRunId = randomUUID();
  const followupRunId = randomUUID();
  const events: ThreadEvent[] = [];
  let nextSequence = 1;
  let cancelled = false;
  let followups = 0;

  const store: ThreadRouteStore = {
    listThreads: async () => [],
    submitThread: async (input) => {
      events.push(
        event(nextSequence++, "run.queued", {
          runId: firstRunId,
          prompt: input.prompt,
          clientMessageId: input.clientMessageId,
        }),
      );

      return { threadId, runId: firstRunId };
    },
    submitMessage: async (input) => {
      followups += 1;
      events.push(
        event(nextSequence++, "run.queued", {
          runId: followupRunId,
          prompt: input.prompt,
          clientMessageId: input.clientMessageId,
        }),
      );

      return { threadId, runId: followupRunId };
    },
    getThread: async () =>
      ({
        id: threadId,
        userId: "user-1",
        title: null,
        repositoryUrl: null,
        repositoryBranch: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [],
        runs: [
          {
            id: firstRunId,
            status: cancelled ? "cancelled" : "running",
            prompt: "start the workspace",
            modelSelection: null,
            cancelRequestedAt: cancelled ? new Date() : null,
            approvalWaitStartedAt: null,
            questionWaitStartedAt: null,
            startedAt: null,
            createdAt: new Date(),
            completedAt: cancelled ? new Date() : null,
            error: null,
          },
        ],
        workspace: null,
        environment: null,
        latestEventId: events.at(-1)?.sequence ?? null,
      }) satisfies ThreadView,
    authorizeThread: async () => undefined,
    listEvents: async ({ after = 0 }) => events.filter((item) => item.sequence > after),
    requestCancel: async () => {
      cancelled = true;
      events.push(event(nextSequence++, "run.cancelled", { runId: firstRunId }));
    },
    listQuestionRequests: async () => [],
    renameThread: async () => undefined,
    deleteThread: async () => undefined,
    answerQuestionRequest: async () => {
      throw new Error("unused");
    },
  };

  return { store, threadId, firstRunId, followupRunId, getFollowups: () => followups };
}

async function listen(store: ThreadRouteStore, session?: AuthSession | null) {
  const app = Fastify({ logger: false });
  registerApiRoutes(app, {
    auth: {
      getSession: async () =>
        session === undefined
          ? { user: { id: "user-1", emailVerified: true }, session: {} }
          : session,
      handler: async () => Response.json({ ok: true }),
    },
    store,
    trustedOrigins: [origin],
    nodeEnv: "test",
    allowUnverifiedCompute: true,
    pollMs: 20,
    heartbeatMs: 200,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();

  const bound = z.object({ port: z.number() }).parse(address);

  return { app, baseUrl: `http://127.0.0.1:${bound.port}` };
}

describe("browser transport against the real routes", () => {
  test("creates a thread, reconnects SSE from the durable cursor, follows up, and cancels", async () => {
    const memory = createMemoryStore();
    const { app, baseUrl } = await listen(memory.store);

    const transport = createApiTransport({ baseUrl, headers: { origin } });

    try {
      expect(parseChecked(z.string(), await transport.request("/"))).toBe("OK");

      const created = parseChecked(
        submitResultSchema,
        await transport.mutate("/api/threads", {
          body: JSON.stringify({ clientMessageId: "message-1", prompt: "start the workspace" }),
        }),
      );

      expect(created).toEqual({ threadId: memory.threadId, runId: memory.firstRunId });

      const firstBatch: Array<{ sequence: number; type: string }> = [];
      const firstAbort = new AbortController();

      const firstStream = transport.streamEvents({
        threadId: created.threadId,
        after: 0,
        signal: firstAbort.signal,
        onEvent: (item) => {
          firstBatch.push({ sequence: item.sequence, type: item.type });

          if (firstBatch.length >= 1) firstAbort.abort();
        },
      });

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only an actual AbortError is expected from cancelling fetch.
      await firstStream.catch((error: unknown) => {
        if (!(error instanceof Error && error.name === "AbortError")) throw error;
      });
      expect(firstBatch).toEqual([{ sequence: 1, type: "run.queued" }]);

      const followup = parseChecked(
        submitResultSchema,
        await transport.mutate(`/api/threads/${created.threadId}/messages`, {
          body: JSON.stringify({ clientMessageId: "message-2", prompt: "continue" }),
        }),
      );

      expect(followup.runId).toBe(memory.followupRunId);
      expect(memory.getFollowups()).toBe(1);

      const replayed: Array<{ sequence: number; type: string }> = [];
      const replayAbort = new AbortController();

      const replay = transport.streamEvents({
        threadId: created.threadId,
        after: firstBatch[0]?.sequence,
        signal: replayAbort.signal,
        onEvent: (item) => {
          replayed.push({ sequence: item.sequence, type: item.type });

          if (replayed.length >= 1) replayAbort.abort();
        },
      });

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Unexpected rejections must still fail the test.
      await replay.catch((error: unknown) => {
        if (!(error instanceof Error && error.name === "AbortError")) throw error;
      });
      expect(replayed.some((item) => item.sequence <= 1)).toBe(false);
      expect(replayed).toEqual([{ sequence: 2, type: "run.queued" }]);

      const cancelled = parseChecked(
        cancelResultSchema,
        await transport.mutate(`/api/threads/${created.threadId}/runs/${created.runId}/cancel`),
      );

      expect(cancelled).toEqual({ runId: created.runId, cancelRequested: true });

      const snapshot = parseChecked(
        threadSnapshotSchema,
        await transport.request(`/api/threads/${created.threadId}`),
      );

      expect(snapshot.runs[0]?.status).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  test("sends credentials and the CSRF header on mutations", async () => {
    const memory = createMemoryStore();
    const { app, baseUrl } = await listen(memory.store);

    const transport = createApiTransport({ baseUrl, headers: { origin } });

    try {
      const missingOrigin = createApiTransport({ baseUrl })
        .mutate("/api/threads", {
          body: JSON.stringify({ clientMessageId: "missing-origin", prompt: "start" }),
        })
        .then((body) => parseChecked(submitResultSchema, body));

      await expect(missingOrigin).rejects.toMatchObject({
        status: 403,
        code: "CSRF_FORBIDDEN",
      } satisfies Partial<ThreadApiError>);

      const created = parseChecked(
        submitResultSchema,
        await transport.mutate("/api/threads", {
          body: JSON.stringify({ clientMessageId: "csrf-ok", prompt: "start the workspace" }),
        }),
      );

      expect(created.threadId).toBe(memory.threadId);
    } finally {
      await app.close();
    }
  });
});
