/* oxlint-disable anti-slop/require-readable-spacing -- Integration scenarios keep related database steps adjacent. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "../src/schema";
import { createThreadStore } from "../src/threads";
import { ThreadStoreError } from "../src/thread-contracts";

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/cloud-swe";

const database = `cloud_swe_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

const testUrl = new URL(baseUrl);

testUrl.pathname = `/${database}`;

let admin: Client;

let pool: Pool;

let store: ReturnType<typeof createThreadStore>;

const userId = `test-user-${randomUUID()}`;

let currentUserId = userId;

async function claim(runId: string, attemptId: string) {
  return store.claimExecutionOwnership({ runId, attemptId, generation: 1 });
}

const sessionHeader = {
  type: "session" as const,
  version: 3,
  id: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/workspace",
};

beforeAll(async () => {
  admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  pool = new Pool({ connectionString: testUrl.toString() });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: new URL("../src/migrations", import.meta.url).pathname });
  await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
    userId,
    "Test",
    `${userId}@example.test`,
  ]);
  store = createThreadStore(db);
});

beforeEach(async () => {
  currentUserId = `test-user-${randomUUID()}`;
  await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
    currentUserId,
    "Test",
    `${currentUserId}@example.test`,
  ]);
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin?.end();
});

describe("ThreadStore PostgreSQL contract", () => {
  test("retries the original run after completion and rejects intent conflicts", async () => {
    const first = await store.submitThread({
      userId: currentUserId,
      prompt: "first",
      clientMessageId: "retry-1",
    });

    const firstOwner = await claim(first.runId, "attempt-complete-1");
    await store.completeRun(first.runId, "done", firstOwner.token);

    const followup = await store.submitMessage({
      userId: currentUserId,
      threadId: first.threadId,
      prompt: "second",
      clientMessageId: "followup-1",
    });

    expect(
      await store.submitThread({
        userId: currentUserId,
        prompt: "first",
        clientMessageId: "retry-1",
      }),
    ).toEqual(first);
    await expect(
      store.submitThread({
        userId: currentUserId,
        prompt: "different",
        clientMessageId: "retry-1",
      }),
    ).rejects.toBeInstanceOf(ThreadStoreError);
    await expect(
      store.submitThread({
        userId: currentUserId,
        prompt: "second",
        clientMessageId: "followup-1",
      }),
    ).rejects.toBeInstanceOf(ThreadStoreError);
    expect(followup.threadId).toBe(first.threadId);
    await store.cancelRun(followup.runId);
  });

  test("persists repository checkout configuration and includes it in idempotency", async () => {
    const first = await store.submitThread({
      userId: currentUserId,
      prompt: "inspect repository",
      clientMessageId: "repository-1",
      repositoryUrl: "https://github.com/example/project.git",
      repositoryBranch: "feature/fix-tests",
    });

    expect(
      (await store.getThread({ userId: currentUserId, threadId: first.threadId })).repositoryUrl,
    ).toBe("https://github.com/example/project.git");
    expect(
      (await store.getThread({ userId: currentUserId, threadId: first.threadId })).repositoryBranch,
    ).toBe("feature/fix-tests");
    expect(
      await store.submitThread({
        userId: currentUserId,
        prompt: "inspect repository",
        clientMessageId: "repository-1",
        repositoryUrl: "https://github.com/example/project.git",
        repositoryBranch: "feature/fix-tests",
      }),
    ).toEqual(first);
    await expect(
      store.submitThread({
        userId: currentUserId,
        prompt: "inspect repository",
        clientMessageId: "repository-1",
        repositoryUrl: "https://github.com/example/project.git",
        repositoryBranch: "main",
      }),
    ).rejects.toBeInstanceOf(ThreadStoreError);
    await store.cancelRun(first.runId);
  });

  test("serializes concurrent idempotent submissions", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.submitThread({
          userId: currentUserId,
          prompt: "parallel",
          clientMessageId: "parallel-1",
        }),
      ),
    );

    expect(new Set(results.map((result) => `${result.threadId}:${result.runId}`)).size).toBe(1);
    await store.cancelRun(results[0]!.runId);
  });

  test("deduplicates concurrent event appends", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "events",
      clientMessageId: "events-1",
      maxActiveRuns: 100,
    });

    const events = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.appendRunEvent({
          runId: submitted.runId,
          type: "token",
          payload: { value: "x" },
          dedupeKey: "token-1",
        }),
      ),
    );

    expect(new Set(events.map((event) => event.sequence)).size).toBe(1);
    await store.cancelRun(submitted.runId);
  });

  test("prevents active user duplicates and terminal resurrection", async () => {
    const first = await store.submitThread({
      userId: currentUserId,
      prompt: "active",
      clientMessageId: "active-1",
    });

    await expect(
      store.submitThread({ userId: currentUserId, prompt: "active2", clientMessageId: "active-2" }),
    ).rejects.toBeInstanceOf(ThreadStoreError);
    const terminalOwner = await claim(first.runId, "attempt-terminal");
    await store.cancelRun(first.runId);
    await store.startRun(first.runId);
    await expect(
      store.saveCheckpoint({
        runId: first.runId,
        key: "pi-session",
        generation: 1,
        attemptId: "attempt-terminal",
        ownershipToken: terminalOwner.token,
        content: { ignored: true },
      }),
    ).rejects.toMatchObject({ code: "RUN_TERMINAL" });
    expect(await store.loadCheckpoint({ runId: first.runId, key: "pi-session" })).toBeNull();
    await expect(
      store.appendRunEvent({ runId: first.runId, type: "late", payload: {}, dedupeKey: "late" }),
    ).rejects.toBeInstanceOf(ThreadStoreError);
  });

  test("updates Pi checkpoints and loads the latest session for a thread", async () => {
    const first = await store.submitThread({
      userId: currentUserId,
      prompt: "checkpoint one",
      clientMessageId: "checkpoint-1",
      maxActiveRuns: 100,
    });

    await store.startRun(first.runId);
    const owner = await claim(first.runId, "attempt-1");
    await store.saveCheckpoint({
      runId: first.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-1",
      ownershipToken: owner.token,
      content: {
        sessionId: "session-1",
        provider: "test",
        model: "test",
        entries: [sessionHeader],
      },
    });
    await store.saveCheckpoint({
      runId: first.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-1",
      ownershipToken: owner.token,
      content: {
        sessionId: "session-1",
        provider: "test",
        model: "test",
        entries: [sessionHeader],
      },
    });
    expect(
      (await store.loadCheckpoint({ runId: first.runId, key: "pi-session" }))?.content,
    ).toMatchObject({ sessionId: "session-1", entries: [sessionHeader] });
    await store.completeRun(first.runId, "done", owner.token);

    const second = await store.submitMessage({
      userId: currentUserId,
      threadId: first.threadId,
      prompt: "checkpoint two",
      clientMessageId: "checkpoint-2",
      maxActiveRuns: 100,
    });

    await store.startRun(second.runId);
    const secondOwner = await claim(second.runId, "attempt-2");
    await store.saveCheckpoint({
      runId: second.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-2",
      ownershipToken: secondOwner.token,
      content: {
        sessionId: "session-1",
        provider: "test",
        model: "test",
        entries: [sessionHeader],
      },
    });
    expect(
      (await store.loadLatestCheckpoint({ threadId: first.threadId, key: "pi-session" }))?.content,
    ).toMatchObject({ sessionId: "session-1", entries: [sessionHeader] });
    await store.cancelRun(second.runId);
  });

  test("stores session entries incrementally and restores after compaction", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "session",
      clientMessageId: "incremental-session",
    });

    const head = { sessionId: "session-1", provider: "test", model: "test" };
    const firstEntry = sessionHeader;

    const secondEntry = {
      type: "message" as const,
      id: "message-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user" as const, content: "hello", timestamp: 1 },
    };

    const save = (entries: unknown[]) =>
      store.saveCheckpoint({
        runId: submitted.runId,
        key: "pi-session",
        generation: 1,
        attemptId: "attempt-1",
        ownershipToken: sessionOwner.token,
        content: { ...head, entries },
      });

    await store.startRun(submitted.runId);
    const sessionOwner = await claim(submitted.runId, "attempt-1");

    await save([firstEntry]);

    const rowVersion = async () =>
      (
        await pool.query<{ version: string }>(
          `select e.xmin::text as version from agent_checkpoint_entry e join agent_checkpoint c on c.id = e.checkpoint_id where c.run_id = $1 and e.ordinal = 0`,
          [submitted.runId],
        )
      ).rows[0]?.version;

    const originalVersion = await rowVersion();
    expect(originalVersion).toBeDefined();
    await save([firstEntry, secondEntry]);
    expect(await rowVersion()).toBe(originalVersion);
    expect(
      (await store.loadCheckpoint({ runId: submitted.runId, key: "pi-session" }))?.content,
    ).toMatchObject({ ...head, entries: [firstEntry, secondEntry] });

    const stored = await pool.query<{ content: { entries?: never } }>(
      `select content from agent_checkpoint where run_id = $1 and key = 'pi-session'`,
      [submitted.runId],
    );

    expect(stored.rows[0]?.content.entries).toBeUndefined();
    const compacted = { ...sessionHeader, id: "session-1" };
    await save([compacted]);
    expect(
      (await store.loadLatestCheckpoint({ threadId: submitted.threadId, key: "pi-session" }))
        ?.content,
    ).toMatchObject({ ...head, entries: [compacted] });
    await store.completeRun(submitted.runId, undefined, sessionOwner.token);
    await expect(save([firstEntry])).rejects.toMatchObject({ code: "RUN_TERMINAL" });
  });

  test("fences checkpoint metadata and entry rows across execution owners", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "ownership fencing",
      clientMessageId: "ownership-fencing-1",
    });

    await store.startRun(submitted.runId);

    await expect(
      store.claimExecutionOwnership({
        runId: submitted.runId,
        attemptId: "attempt-wrong-generation",
        generation: 2,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_GENERATION_MISMATCH" });

    const ownerA = await claim(submitted.runId, "attempt-owner-a");
    const repeatedA = await claim(submitted.runId, "attempt-owner-a");
    expect(repeatedA.token).toBe(ownerA.token);

    const contentA = {
      sessionId: "session-1",
      provider: "test",
      model: "test",
      entries: [
        sessionHeader,
        {
          type: "message" as const,
          id: "message-owner-a",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user" as const, content: "owner A", timestamp: 1 },
        },
      ],
    };

    const contentB = {
      sessionId: "session-1",
      provider: "test",
      model: "test",
      entries: [
        sessionHeader,
        {
          type: "message" as const,
          id: "message-owner-b-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user" as const, content: "owner B one", timestamp: 2 },
        },
        {
          type: "message" as const,
          id: "message-owner-b-2",
          parentId: "message-owner-b-1",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: { role: "user" as const, content: "owner B two", timestamp: 3 },
        },
      ],
    };

    await expect(
      store.saveCheckpoint({
        runId: submitted.runId,
        key: "pi-session",
        generation: 2,
        attemptId: "attempt-owner-a",
        ownershipToken: ownerA.token,
        content: contentA,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_GENERATION_MISMATCH" });

    // Owner A's write commits before replacement. This proves the later owner
    // must fence an existing checkpoint, not only reject an initial insert.
    await store.saveCheckpoint({
      runId: submitted.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-owner-a",
      ownershipToken: ownerA.token,
      content: contentA,
    });

    const ownerB = await claim(submitted.runId, "attempt-owner-b");
    await expect(claim(submitted.runId, "attempt-owner-a")).rejects.toMatchObject({
      code: "CHECKPOINT_OWNERSHIP_LOST",
    });

    await store.saveCheckpoint({
      runId: submitted.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-owner-b",
      ownershipToken: ownerB.token,
      content: contentB,
    });

    await expect(
      store.saveCheckpoint({
        runId: submitted.runId,
        key: "pi-session",
        generation: 1,
        attemptId: "attempt-owner-a",
        ownershipToken: ownerA.token,
        content: contentA,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_OWNERSHIP_LOST" });

    expect(
      (await store.loadCheckpoint({ runId: submitted.runId, key: "pi-session" }))?.content,
    ).toMatchObject(contentB);

    const entryRows = await pool.query<{ ordinal: number; content: unknown }>(
      `select e.ordinal, e.content from agent_checkpoint_entry e join agent_checkpoint c on c.id = e.checkpoint_id where c.run_id = $1 order by e.ordinal`,
      [submitted.runId],
    );

    expect(entryRows.rows).toEqual(
      contentB.entries.map((content, ordinal) => ({ ordinal, content })),
    );

    await expect(store.completeRun(submitted.runId, "stale", ownerA.token)).rejects.toMatchObject({
      code: "CHECKPOINT_OWNERSHIP_LOST",
    });
    await store.completeRun(submitted.runId, "current", ownerB.token);
    expect((await store.loadRun(submitted.runId))?.status).toBe("completed");
    await expect(claim(submitted.runId, "attempt-after-terminal")).rejects.toMatchObject({
      code: "RUN_TERMINAL",
    });
  });

  test("serializes ownership changes racing with checkpoint writes", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "ownership race",
      clientMessageId: "ownership-race-1",
      maxActiveRuns: 100,
    });
    await store.startRun(submitted.runId);

    const ownerA = await claim(submitted.runId, "attempt-race-a");
    const contentA = {
      sessionId: "session-race",
      provider: "test",
      model: "test",
      entries: [{ ...sessionHeader, id: "session-race" }],
    };
    const contentB = {
      sessionId: "session-race",
      provider: "test",
      model: "test",
      entries: [
        { ...sessionHeader, id: "session-race" },
        {
          type: "message" as const,
          id: "race-b-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:04.000Z",
          message: { role: "user" as const, content: "B one", timestamp: 4 },
        },
        {
          type: "message" as const,
          id: "race-b-2",
          parentId: "race-b-1",
          timestamp: "2026-01-01T00:00:05.000Z",
          message: { role: "user" as const, content: "B two", timestamp: 5 },
        },
      ],
    };

    const [writeA, claimB] = await Promise.allSettled([
      store.saveCheckpoint({
        runId: submitted.runId,
        key: "pi-session",
        generation: 1,
        attemptId: "attempt-race-a",
        ownershipToken: ownerA.token,
        content: contentA,
      }),
      store.claimExecutionOwnership({
        runId: submitted.runId,
        attemptId: "attempt-race-b",
        generation: 1,
      }),
    ]);

    if (claimB.status === "rejected") throw claimB.reason;
    const ownerB = claimB.value;
    if (writeA.status === "rejected") {
      expect(writeA.reason).toMatchObject({ code: "CHECKPOINT_OWNERSHIP_LOST" });
    } else {
      expect(writeA.status).toBe("fulfilled");
    }

    await store.saveCheckpoint({
      runId: submitted.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-race-b",
      ownershipToken: ownerB.token,
      content: contentB,
    });

    await expect(
      store.saveCheckpoint({
        runId: submitted.runId,
        key: "pi-session",
        generation: 1,
        attemptId: "attempt-race-a",
        ownershipToken: ownerA.token,
        content: contentA,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_OWNERSHIP_LOST" });

    const entryRows = await pool.query<{ ordinal: number; content: unknown }>(
      `select e.ordinal, e.content from agent_checkpoint_entry e join agent_checkpoint c on c.id = e.checkpoint_id where c.run_id = $1 order by e.ordinal`,
      [submitted.runId],
    );
    expect(entryRows.rows).toEqual(
      contentB.entries.map((content, ordinal) => ({ ordinal, content })),
    );
    await store.completeRun(submitted.runId, "race complete", ownerB.token);
  });

  test("sanitizes credential-bearing failures before durable writes", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "credential failure",
      clientMessageId: "credential-failure-1",
    });
    const credentials = [
      "Bearer bearer-secret",
      "Basic basic-secret",
      'Cookie session="cookie-secret"; other=second-cookie',
      "Authorization: Bearer quoted-secret\nX-Api-Key: multiline-secret",
      "https://user:url-secret@example.test/path?token=query-secret",
    ].join(" | ");
    await store.startRun(submitted.runId);
    const owner = await claim(submitted.runId, "attempt-credential");
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "failed", textSignature: "safe-text" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error" as const,
      errorMessage: credentials,
      rawStopReason: credentials,
      diagnostics: [
        {
          type: "provider",
          timestamp: 1,
          error: {
            name: credentials,
            code: credentials,
            message: credentials,
          },
        },
      ],
      timestamp: 1,
    };
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "call-credential",
      toolName: "test",
      content: [{ type: "text" as const, text: credentials }],
      details: { nestedFailure: credentials },
      isError: true,
      timestamp: 2,
    };
    await store.saveCheckpoint({
      runId: submitted.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-credential",
      ownershipToken: owner.token,
      content: {
        sessionId: "session-1",
        provider: "test",
        model: "test",
        entries: [
          sessionHeader,
          {
            type: "message" as const,
            id: "assistant-credential",
            parentId: null,
            timestamp: "2026-01-01T00:00:01.000Z",
            message: assistant,
          },
          {
            type: "message" as const,
            id: "tool-credential",
            parentId: "assistant-credential",
            timestamp: "2026-01-01T00:00:02.000Z",
            message: toolResult,
          },
        ],
      },
    });

    const rawEntries = await pool.query<{ content: unknown }>(
      `select e.content from agent_checkpoint_entry e join agent_checkpoint c on c.id = e.checkpoint_id where c.run_id = $1 order by e.ordinal`,
      [submitted.runId],
    );
    const syntheticSecrets = [
      "bearer-secret",
      "basic-secret",
      "cookie-secret",
      "second-cookie",
      "quoted-secret",
      "multiline-secret",
      "url-secret",
      "query-secret",
    ];
    for (const secret of syntheticSecrets) {
      expect(JSON.stringify(rawEntries.rows)).not.toContain(secret);
    }
    const restored = await store.loadCheckpoint({ runId: submitted.runId, key: "pi-session" });
    expect(JSON.stringify(restored)).not.toContain(credentials);
    expect(JSON.stringify(restored)).toContain("Agent execution failed");
    expect(JSON.stringify(restored)).toContain("safe-text");
    expect(JSON.stringify(restored)).not.toContain("rawStopReason");
    for (const secret of syntheticSecrets) {
      expect(JSON.stringify(restored)).not.toContain(secret);
    }

    await store.failRun(submitted.runId, credentials);
    const durableRun = await pool.query<{ error: string; payload: unknown }>(
      `select r.error, e.payload from run r join thread_event e on e.thread_id = r.thread_id and e.type = 'run.failed' where r.id = $1`,
      [submitted.runId],
    );
    for (const secret of syntheticSecrets) {
      expect(JSON.stringify(durableRun.rows)).not.toContain(secret);
    }

    const outbox = (await store.listPendingOutbox()).find(
      (entry) => entry.runId === submitted.runId,
    );
    if (!outbox) throw new Error("expected a pending run outbox row");
    await store.recordFailure(outbox.id, credentials);
    const durableOutbox = await pool.query<{ last_error: string }>(
      `select last_error from outbox where id = $1`,
      [outbox.id],
    );
    expect(durableOutbox.rows[0]?.last_error).toBe("Agent execution failed");
    for (const secret of syntheticSecrets) {
      expect(JSON.stringify(durableOutbox.rows)).not.toContain(secret);
    }
  });

  test("rejects corrupt inline and separate durable checkpoints without rewriting them", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "corrupt checkpoint",
      clientMessageId: "corrupt-checkpoint-1",
    });
    await store.startRun(submitted.runId);
    const owner = await claim(submitted.runId, "attempt-corrupt");
    const validContent = {
      sessionId: "session-1",
      provider: "test",
      model: "test",
      entries: [sessionHeader],
    };
    await store.saveCheckpoint({
      runId: submitted.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-corrupt",
      ownershipToken: owner.token,
      content: validContent,
    });

    await pool.query(`update agent_checkpoint set content = $1 where run_id = $2`, [
      { sessionId: "session-1", provider: "test", model: "test", entries: [{}] },
      submitted.runId,
    ]);
    await expect(
      store.loadCheckpoint({ runId: submitted.runId, key: "pi-session" }),
    ).rejects.toMatchObject({
      code: "INVALID_CHECKPOINT",
    });

    await store.saveCheckpoint({
      runId: submitted.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-corrupt",
      ownershipToken: owner.token,
      content: validContent,
    });
    await pool.query(
      `update agent_checkpoint_entry set content = $1 where checkpoint_id = (select id from agent_checkpoint where run_id = $2)`,
      [{ malformed: true }, submitted.runId],
    );
    await expect(
      store.loadCheckpoint({ runId: submitted.runId, key: "pi-session" }),
    ).rejects.toMatchObject({
      code: "INVALID_CHECKPOINT",
    });
    const unchanged = await pool.query<{ content: unknown }>(
      `select e.content from agent_checkpoint_entry e join agent_checkpoint c on c.id = e.checkpoint_id where c.run_id = $1`,
      [submitted.runId],
    );
    expect(unchanged.rows[0]?.content).toEqual({ malformed: true });
  });

  test("returns an ordered cursor from a consistent snapshot", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "cursor",
      clientMessageId: "cursor-1",
      maxActiveRuns: 100,
    });

    await store.appendRunEvent({
      runId: submitted.runId,
      type: "one",
      payload: {},
      dedupeKey: "one",
    });
    const view = await store.getThread({ userId: currentUserId, threadId: submitted.threadId });
    const events = await store.listEvents({ threadId: submitted.threadId });
    expect(view.latestEventId).toBe(events.at(-1)?.sequence ?? null);
    expect(events.map((event) => event.sequence)).toEqual(
      [...events].map((event) => event.sequence).sort((a, b) => a - b),
    );
    await store.cancelRun(submitted.runId);
  });

  test("requires an explicit provider when creating a workspace", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "provider",
      clientMessageId: "provider-required",
    });

    await expect(
      store.updateWorkspace({ threadId: submitted.threadId, state: "provisioning" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_PROVIDER_REQUIRED" });

    const created = await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "provisioning",
      provider: "freestyle",
    });

    expect(created.provider).toBe("freestyle");
    expect(
      (await store.updateWorkspace({ threadId: submitted.threadId, state: "running" })).provider,
    ).toBe("freestyle");
    const owner = await claim(submitted.runId, "attempt-provider");
    await store.completeRun(submitted.runId, undefined, owner.token);
  });

  test("records each workspace state transition while deduplicating no-ops", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "workspace",
      clientMessageId: "workspace-1",
      maxActiveRuns: 100,
    });

    await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "provisioning",
      provider: "docker",
    });
    await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "running",
      provider: "docker",
    });
    await store.updateWorkspace({ threadId: submitted.threadId, state: "paused" });
    await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "running",
      provider: "docker",
    });
    await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "running",
      provider: "docker",
    });
    const events = await store.listEvents({ threadId: submitted.threadId });
    expect(
      events.filter((event) => event.type.startsWith("workspace.")).map((event) => event.type),
    ).toEqual([
      "workspace.provisioning",
      "workspace.running",
      "workspace.paused",
      "workspace.running",
    ]);
    expect((await store.readWorkspace(submitted.threadId))?.lifecycleTransitionId).toBeNull();
    await store.cancelRun(submitted.runId);
  });

  test("defers cleanup while an undelivered queued run exists", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "queued cleanup",
      clientMessageId: "cleanup-queued-1",
      maxActiveRuns: 100,
    });

    await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "running",
      provider: "docker",
    });

    const deferred = await store.cleanupWorkspace({
      threadId: submitted.threadId,
      targetState: "deleted",
      mutate: async () => ({ outcome: "completed" }),
    });

    expect(deferred.outcome).toBe("deferred");

    if (deferred.outcome === "deferred") expect(deferred.reason).toBe("active-run");
    const pendingOutbox = await store.listPendingOutbox();
    expect(pendingOutbox.some((entry) => entry.runId === submitted.runId)).toBe(true);
    await store.cancelRun(submitted.runId);

    const completed = await store.cleanupWorkspace({
      threadId: submitted.threadId,
      transitionId: deferred.transitionId,
      targetState: "deleted",
      mutate: async () => ({ outcome: "completed" }),
    });

    expect(completed.outcome).toBe("completed");
    expect((await store.readWorkspace(submitted.threadId))?.state).toBe("deleted");
  });

  test("cleanup blocks its thread without blocking unrelated admission or cancellation", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "lock cleanup",
      clientMessageId: "cleanup-lock-1",
      maxActiveRuns: 100,
    });

    const owner = await claim(submitted.runId, "attempt-cleanup");
    await store.completeRun(submitted.runId, undefined, owner.token);
    await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "running",
      provider: "docker",
    });
    let started = false;
    let releaseMutation: (() => void) | undefined;

    const mutationReleased = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });

    const cleanup = store.cleanupWorkspace({
      threadId: submitted.threadId,
      targetState: "deleted",
      mutate: async () => {
        started = true;
        await mutationReleased;

        return { outcome: "completed" };
      },
    });

    for (let attempt = 0; attempt < 50 && !started; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(started).toBe(true);
    let submittedFollowup = false;

    const followup = store
      .submitMessage({
        userId: currentUserId,
        threadId: submitted.threadId,
        prompt: "must wait for cleanup",
        clientMessageId: "cleanup-lock-followup",
        maxActiveRuns: 100,
      })
      .then((result) => {
        submittedFollowup = true;

        return result;
      });

    try {
      let waitingForThread = false;

      for (let attempt = 0; attempt < 100 && !waitingForThread; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(
          `select exists(select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%"thread"%') as waiting`,
        );

        waitingForThread = waiting.rows[0]?.waiting === true;

        if (!waitingForThread) await new Promise((resolve) => setTimeout(resolve, 2));
      }

      expect(waitingForThread).toBe(true);
      expect(submittedFollowup).toBe(false);
      const otherUserId = `cleanup-other-${randomUUID()}`;
      await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
        otherUserId,
        "Other",
        `${otherUserId}@example.test`,
      ]);

      const unrelated = await Promise.race([
        store.submitThread({
          userId: otherUserId,
          prompt: "independent",
          clientMessageId: "cleanup-unrelated",
          maxActiveRuns: 100,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Cleanup blocked global admission")), 1000),
        ),
      ]);

      await store.requestCancel({
        userId: otherUserId,
        threadId: unrelated.threadId,
        runId: unrelated.runId,
      });
      expect((await store.loadRun(unrelated.runId))?.cancelRequestedAt).not.toBeNull();
      await store.cancelRun(unrelated.runId);
    } finally {
      releaseMutation?.();
    }

    expect((await cleanup).outcome).toBe("completed");
    expect((await followup).threadId).toBe(submitted.threadId);
    await store.cancelRun((await followup).runId);
  });

  test("owns command operations by workspace generation, run, and attempt", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "command ownership",
      clientMessageId: "command-ownership-1",
      maxActiveRuns: 100,
    });

    await store.startRun(submitted.runId);
    await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "running",
      provider: "docker",
    });
    const currentWorkspace = await store.readWorkspace(submitted.threadId);

    if (!currentWorkspace) throw new Error("workspace was not created");

    const operation = await store.beginCommand({
      workspaceId: currentWorkspace.id,
      generation: currentWorkspace.generation,
      runId: submitted.runId,
      attemptId: "attempt-command-1",
      metadata: { kind: "remote_exec", command: "true" },
    });

    expect(operation.state).toBe("pending");
    await expect(
      store.beginCommand({
        workspaceId: currentWorkspace.id,
        generation: currentWorkspace.generation,
        runId: submitted.runId,
        attemptId: "attempt-command-2",
        metadata: { kind: "remote_exec", command: "false" },
      }),
    ).rejects.toMatchObject({ code: "COMMAND_UNSETTLED" });
    await expect(
      store.beginCommand({
        commandId: operation.commandId,
        workspaceId: currentWorkspace.id,
        generation: currentWorkspace.generation,
        runId: submitted.runId,
        attemptId: "different-attempt",
        metadata: operation.metadata,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_OWNERSHIP_CONFLICT" });
    await store.updateCommand({
      commandId: operation.commandId,
      state: "running",
      cancellationRequested: true,
    });

    const completed = await store.updateCommand({
      commandId: operation.commandId,
      state: "completed",
      result: { exitCode: 0 },
    });

    expect(completed.cancellationRequested).toBe(true);
    expect((await store.listUnsettledCommands({ workspaceId: currentWorkspace.id })).length).toBe(
      0,
    );

    const next = await store.beginCommand({
      workspaceId: currentWorkspace.id,
      generation: currentWorkspace.generation,
      runId: submitted.runId,
      attemptId: "attempt-command-3",
      metadata: { kind: "remote_read", path: "/workspace" },
    });

    expect(next.commandId).not.toBe(operation.commandId);
    await store.updateCommand({
      commandId: next.commandId,
      state: "failed",
      result: { exitCode: 1 },
    });
    await store.cancelRun(submitted.runId);
  });

  test("defers cleanup for an unsettled command after the run is terminal", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "unsettled cleanup",
      clientMessageId: "cleanup-command-1",
      maxActiveRuns: 100,
    });

    await store.startRun(submitted.runId);

    const workspace = await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "running",
      provider: "docker",
    });

    const operation = await store.beginCommand({
      workspaceId: workspace.id,
      generation: workspace.generation,
      runId: submitted.runId,
      attemptId: "cleanup-command-attempt",
      metadata: { kind: "remote_exec" },
    });

    await store.cancelRun(submitted.runId);

    const deferred = await store.cleanupWorkspace({
      threadId: submitted.threadId,
      targetState: "deleted",
      mutate: async () => ({ outcome: "completed" }),
    });

    expect(deferred.outcome).toBe("deferred");

    if (deferred.outcome === "deferred") expect(deferred.reason).toBe("unsettled-command");
    await store.updateCommand({
      commandId: operation.commandId,
      state: "failed",
      result: { kind: "failed", reason: "guest command failed" },
    });

    const completed = await store.cleanupWorkspace({
      threadId: submitted.threadId,
      targetState: "deleted",
      transitionId: deferred.transitionId,
      mutate: async () => ({ outcome: "completed" }),
    });

    expect(completed.outcome).toBe("completed");
  });

  test("increments generations atomically and makes reset retries idempotent", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "generation reset",
      clientMessageId: "generation-1",
      maxActiveRuns: 100,
    });

    await store.startRun(submitted.runId);
    await store.updateWorkspace({
      threadId: submitted.threadId,
      state: "running",
      provider: "docker",
    });
    const before = await store.readWorkspace(submitted.threadId);

    if (!before) throw new Error("workspace was not created");
    const owner = await claim(submitted.runId, "attempt-generation-1");
    await store.saveCheckpoint({
      runId: submitted.runId,
      key: "pi-session",
      generation: before.generation,
      attemptId: "attempt-generation-1",
      ownershipToken: owner.token,
      content: {
        sessionId: "session-1",
        provider: "test",
        model: "test",
        entries: [sessionHeader],
      },
    });

    const operation = await store.beginCommand({
      workspaceId: before.id,
      generation: before.generation,
      runId: submitted.runId,
      attemptId: "attempt-generation-1",
      metadata: { kind: "remote_exec" },
    });

    await store.cancelRun(submitted.runId);
    await expect(
      store.resetWorkspace({
        threadId: submitted.threadId,
        expectedGeneration: before.generation,
        confirmedMissing: false,
        reason: "provider returned ambiguous loss",
      }),
    ).rejects.toMatchObject({ code: "RESET_NOT_CONFIRMED" });

    const reset = await store.resetWorkspace({
      threadId: submitted.threadId,
      expectedGeneration: before.generation,
      confirmedMissing: true,
      transitionId: "reset-transition-1",
      reason: "provider confirmed VM missing",
    });

    expect(reset.alreadyApplied).toBe(false);
    expect(reset.oldGeneration).toBe(before.generation);
    expect(reset.newGeneration).toBe(before.generation + 1);
    expect(reset.event.type).toBe("workspace.reset");
    expect((await store.readWorkspace(submitted.threadId))?.generation).toBe(reset.newGeneration);
    expect((await store.readCommand(operation.commandId))?.state).toBe("unknown");

    const retried = await store.resetWorkspace({
      threadId: submitted.threadId,
      expectedGeneration: before.generation,
      confirmedMissing: true,
      transitionId: "reset-transition-1",
      reason: "retry after worker crash",
    });

    expect(retried.alreadyApplied).toBe(true);
    expect(retried.newGeneration).toBe(reset.newGeneration);
    expect(
      (
        await store.loadLatestCheckpoint({
          threadId: submitted.threadId,
          key: "pi-session",
          generation: before.generation,
        })
      )?.content,
    ).toMatchObject({ sessionId: "session-1", entries: [sessionHeader] });
    expect(
      await store.loadLatestCheckpoint({
        threadId: submitted.threadId,
        key: "pi-session",
        generation: reset.newGeneration,
      }),
    ).toBeNull();
  });

  test("maps concurrent submissions to database admission conflicts", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        store.submitThread({
          userId: currentUserId,
          prompt: `race-${index}`,
          clientMessageId: `race-${index}`,
          maxActiveRuns: 100,
        }),
      ),
    );

    const accepted = results.filter((result) => result.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBe(7);

    for (const result of rejected) expect(result.reason).toMatchObject({ code: "USER_BUSY" });
    const winner = accepted[0];

    if (winner?.status === "fulfilled") await store.cancelRun(winner.value.runId);
  });
});
