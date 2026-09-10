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
    await store.completeRun(first.runId, "done");
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
    await store.cancelRun(first.runId);
    await store.startRun(first.runId);
    await expect(
      store.saveCheckpoint({
        runId: first.runId,
        key: "pi-session",
        generation: 1,
        attemptId: "attempt-terminal",
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
    await store.saveCheckpoint({
      runId: first.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-1",
      content: { version: 1 },
    });
    await store.saveCheckpoint({
      runId: first.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-1",
      content: { version: 2 },
    });
    expect(
      (await store.loadCheckpoint({ runId: first.runId, key: "pi-session" }))?.content,
    ).toEqual({
      version: 2,
    });
    await store.completeRun(first.runId, "done");

    const second = await store.submitMessage({
      userId: currentUserId,
      threadId: first.threadId,
      prompt: "checkpoint two",
      clientMessageId: "checkpoint-2",
      maxActiveRuns: 100,
    });
    await store.startRun(second.runId);
    await store.saveCheckpoint({
      runId: second.runId,
      key: "pi-session",
      generation: 1,
      attemptId: "attempt-2",
      content: { version: 3 },
    });
    expect(
      (await store.loadLatestCheckpoint({ threadId: first.threadId, key: "pi-session" }))?.content,
    ).toEqual({ version: 3 });
    await store.cancelRun(second.runId);
  });

  test("stores session entries incrementally and restores after compaction", async () => {
    const submitted = await store.submitThread({
      userId: currentUserId,
      prompt: "session",
      clientMessageId: "incremental-session",
    });
    const head = { sessionId: "session-1", provider: "test", model: "test" };
    const firstEntry = { type: "session", id: "session-1" };
    const secondEntry = {
      type: "message",
      id: "message-1",
      message: { role: "user", content: "hello" },
    };
    const save = (entries: unknown[]) =>
      store.saveCheckpoint({
        runId: submitted.runId,
        key: "pi-session",
        generation: 1,
        attemptId: "attempt-1",
        content: { ...head, entries },
      });
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
    ).toEqual({ ...head, entries: [firstEntry, secondEntry] });
    const stored = await pool.query<{ content: Record<string, unknown> }>(
      `select content from agent_checkpoint where run_id = $1 and key = 'pi-session'`,
      [submitted.runId],
    );
    expect(stored.rows[0]?.content.entries).toBeUndefined();
    const compacted = { type: "session", id: "compacted-session" };
    await save([compacted]);
    expect(
      (await store.loadLatestCheckpoint({ threadId: submitted.threadId, key: "pi-session" }))
        ?.content,
    ).toEqual({ ...head, entries: [compacted] });
    await store.completeRun(submitted.runId);
    await expect(save([firstEntry])).rejects.toMatchObject({ code: "RUN_TERMINAL" });
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
    await store.completeRun(submitted.runId);
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
    await store.completeRun(submitted.runId);
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
    await store.saveCheckpoint({
      runId: submitted.runId,
      key: "pi-session",
      generation: before.generation,
      attemptId: "attempt-generation-1",
      content: { entries: ["old"] },
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
    ).toEqual({ entries: ["old"] });
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
