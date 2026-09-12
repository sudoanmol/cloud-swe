import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";

const commandResultSchema = z.object({
  stdout: z.string(),
  kind: z.string(),
  statusCode: z.number().nullable(),
});

import type { ChildProcess } from "node:child_process";
import {
  BACKEND_TESTS_ENABLED,
  createIntegrationHarness,
  observeStable,
  poll,
  resultSchema,
  snapshotSchema,
  stopProcess,
  type Snapshot,
} from "./integration-helpers.js";
import {
  buildRemoteWriteCommand,
  createPiResourceLoader,
  normalizePiCommandResult,
  PI_TOOL_NAMES,
} from "../src/pi.js";
import { processResult, transportResult } from "../src/sandbox.js";

// Real local Docker + Temporal + disposable Postgres per process
// (`cloud_swe_e2e_<pid>`). Skippable via SKIP_BACKEND_TESTS=1. Phases bind unit
// contracts to real containers and durable rows with polling and bounded
// deadlines. No fixed sleeps, no paid Freestyle/AI calls.
const backendEnabled = BACKEND_TESTS_ENABLED;

const harness = createIntegrationHarness({ portBase: 31_000 });

let server: ChildProcess | undefined;

let worker: ChildProcess | undefined;

let dispatcher: ChildProcess | undefined;

function email(label: string): string {
  return `backend-${harness.pid}-${label}@example.com`;
}

async function submitThread(cookie: string, prompt: string, clientMessageId: string) {
  const result = await harness.http(
    "/api/threads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, clientMessageId }),
    },
    cookie,
  );

  expect(result.response.status, `${clientMessageId}: ${result.text}`).toBe(202);

  return resultSchema.parse(result.body);
}

async function submitMessage(
  cookie: string,
  threadId: string,
  prompt: string,
  clientMessageId: string,
) {
  const result = await harness.http(
    `/api/threads/${threadId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, clientMessageId }),
    },
    cookie,
  );

  expect(result.response.status, `${clientMessageId}: ${result.text}`).toBe(202);

  return resultSchema.parse(result.body);
}

async function fetchSnapshot(cookie: string, threadId: string): Promise<Snapshot> {
  const result = await harness.http(`/api/threads/${threadId}`, {}, cookie);
  expect(result.response.ok, `snapshot failed: ${result.response.status} ${result.text}`).toBe(
    true,
  );

  return snapshotSchema.parse(result.body);
}

async function waitForCompleted(
  cookie: string,
  threadId: string,
  runId: string,
  timeoutMs = 60_000,
): Promise<Snapshot> {
  const snapshot = await harness
    .waitSnapshot(
      cookie,
      threadId,
      (item) =>
        item.runs.some(
          (run) => run.id === runId && ["completed", "failed", "cancelled"].includes(run.status),
        ),
      { timeoutMs, label: `run ${runId} terminal state` },
    )
    .catch((error) => {
      const processes = Object.entries({ server, worker, dispatcher }).map(([role, child]) => ({
        role,
        pid: child?.pid,
        exitCode: child?.exitCode,
        signalCode: child?.signalCode,
        tail: child ? harness.tails.get(child) : undefined,
      }));

      throw new Error(`Run did not settle; backend processes: ${JSON.stringify(processes)}`, {
        cause: error,
      });
    });

  const run = snapshot.runs.find((item) => item.id === runId);
  expect(run, `run ${runId} was not returned in its thread snapshot`).toBeDefined();
  expect(run?.status, run?.error ?? `run ${runId} did not complete`).toBe("completed");

  return snapshot;
}

async function keepQueuedWhileCleanupRuns(cookie: string, threadId: string, runId: string) {
  const cleanupWindow = Number(harness.runtimeEnv.RUNNER_CLEANUP_MS) + 1_500;
  const deadline = Date.now() + cleanupWindow;
  let observations = 0;

  while (Date.now() < deadline) {
    const snapshot = await fetchSnapshot(cookie, threadId);
    const run = snapshot.runs.find((item) => item.id === runId);
    expect(
      run?.status,
      `queued follow-up changed unexpectedly: ${run?.error ?? "missing run"}`,
    ).toBe("queued");
    expect(
      snapshot.workspace,
      "cleanup removed the workspace with an accepted queued run",
    ).not.toBeNull();
    expect(snapshot.workspace?.state).not.toBe("deleted");
    observations += 1;
    await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }

  expect(observations).toBeGreaterThan(2);
}

beforeAll(async () => {
  if (!backendEnabled) return;
  ({ server, worker, dispatcher } = await harness.setup());
}, 120_000);

afterAll(async () => {
  if (!backendEnabled) return;
  await harness.cleanup();
}, 120_000);

test.skipIf(!backendEnabled)(
  "phase: a borrowed PostgreSQL connection fails without stopping the runner",
  async () => {
    const result = await harness.commandWithStdin(
      "node",
      ["--import", "./apps/runner/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-"],
      `import assert from "node:assert/strict";
process.env.DATABASE_URL = ${JSON.stringify(harness.databaseUrl)};
const { createRunnerDatabase } = await import("./apps/runner/src/db.ts");
const database = createRunnerDatabase();
const client = await database.pool.connect();
const ended = Promise.withResolvers();
client.once("end", ended.resolve);
await client.query("begin");
const { rows } = await client.query("select pg_backend_pid() as pid");
await database.pool.query("select pg_terminate_backend($1)", [rows[0].pid]);
await ended.promise;
await assert.rejects(client.query("select 1"), /not queryable/);
client.release();
assert.equal((await database.pool.query("select 1 as value")).rows[0].value, 1);
await database.close();`,
    );

    expect(result.code, result.stderr).toBe(0);
  },
  60_000,
);

test.skipIf(!backendEnabled)(
  "phase: canonical HTTP route, auth, idempotency, SSE, and CSRF",
  async () => {
    const unauthenticated = await harness.http("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "unauthenticated", clientMessageId: `unauth-${harness.pid}` }),
    });

    expect(unauthenticated.response.status).toBe(401);

    const cookieA = await harness.signup(email("http-a"));
    const cookieB = await harness.signup(email("http-b"));

    const invalidBranch = await harness.http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "invalid branch",
          clientMessageId: `invalid-branch-${harness.pid}`,
          repositoryUrl: "https://github.com/example/project",
          branch: "feature..broken",
        }),
      },
      cookieA,
    );

    expect(invalidBranch.response.status).toBe(400);

    const body = {
      prompt: "fixed script",
      clientMessageId: `idempotent-${harness.pid}`,
    };

    const concurrent = await Promise.all([
      harness.http(
        "/api/threads",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        cookieA,
      ),
      harness.http(
        "/api/threads",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        cookieA,
      ),
    ]);

    expect(concurrent[0]?.response.status).toBe(202);
    expect(concurrent[1]?.response.status).toBe(202);
    expect(JSON.stringify(concurrent[0]?.body)).toBe(JSON.stringify(concurrent[1]?.body));
    const result = resultSchema.parse(concurrent[0]?.body);

    const crossUserSnapshot = await harness.http(`/api/threads/${result.threadId}`, {}, cookieB);
    expect(crossUserSnapshot.response.status).toBe(404);

    const crossUserStream = await harness.http(
      `/api/threads/${result.threadId}/events?after=0`,
      {},
      cookieB,
    );

    expect(crossUserStream.response.status).toBe(404);

    const completed = await waitForCompleted(cookieA, result.threadId, result.runId);

    const retry = await harness.http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      cookieA,
    );

    expect(retry.response.status).toBe(202);
    expect(JSON.stringify(resultSchema.parse(retry.body))).toBe(JSON.stringify(result));
    expect(completed.runs.filter((run) => run.id === result.runId)).toHaveLength(1);

    const events = await harness.readSse(cookieA, result.threadId, 0, new Set(["run.completed"]), {
      timeoutMs: 15_000,
    });

    const sequences = events.map((event) => Number(event.id));
    expect(events.some((event) => event.type === "tool.started")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "tool.output" &&
          JSON.stringify(event.payload).includes("scripted runner completed"),
      ),
    ).toBe(true);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences.every((value) => Number.isInteger(value) && value > 0)).toBe(true);
    expect(
      sequences.every((value, index) => index === 0 || value > (sequences[index - 1] ?? 0)),
    ).toBe(true);

    for (const event of events.filter((item) =>
      ["assistant", "tool"].some((prefix) => item.type.startsWith(prefix)),
    )) {
      expect(event.payload.runId, `${event.type} did not include its run ID`).toBe(result.runId);
    }

    if (dispatcher) await stopProcess(dispatcher);
    const queued = await submitThread(cookieB, "cancel before dispatch", `queued-${harness.pid}`);

    const untrustedCancel = await harness.http(
      `/api/threads/${queued.threadId}/runs/${queued.runId}/cancel`,
      {
        method: "POST",
        headers: { origin: "https://evil.example", "x-csrf-protection": "1" },
      },
      cookieB,
    );

    expect(untrustedCancel.response.status).toBe(403);

    const missingToken = await harness.http(
      `/api/threads/${queued.threadId}/runs/${queued.runId}/cancel`,
      { method: "POST", headers: { origin: harness.baseUrl, "x-csrf-protection": "" } },
      cookieB,
    );

    expect(missingToken.response.status).toBe(403);

    const untouched = await harness.waitSnapshot(
      cookieB,
      queued.threadId,
      (item) => item.runs.some((run) => run.id === queued.runId && run.status === "queued"),
      { timeoutMs: 5_000, label: "CSRF-rejected cancellation to leave the run queued" },
    );

    expect(untouched.runs.find((run) => run.id === queued.runId)?.cancelRequestedAt).toBeNull();

    const trustedCancel = await harness.http(
      `/api/threads/${queued.threadId}/runs/${queued.runId}/cancel`,
      { method: "POST" },
      cookieB,
    );

    expect(trustedCancel.response.status).toBe(202);
    dispatcher = harness.startDispatcher();

    const cancelled = await harness.waitSnapshot(
      cookieB,
      queued.threadId,
      (item) => item.runs.some((run) => run.id === queued.runId && run.status === "cancelled"),
      { timeoutMs: 30_000, label: "queued cancellation" },
    );

    expect(cancelled.runs.find((run) => run.id === queued.runId)?.status).toBe("cancelled");
  },
  180_000,
);

test.skipIf(!backendEnabled)(
  "phase: production admission rejects an unverified account",
  async () => {
    const cookie = await harness.signup(email("production-unverified"));

    if (server) await stopProcess(server);
    server = await harness.startServer({
      NODE_ENV: "production",
      GITHUB_CLIENT_ID: "Iv1.e2e-client",
      GITHUB_CLIENT_SECRET: "e2e-github-app-secret",
    });

    try {
      const denied = await harness.http(
        "/api/threads",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: "production compute admission",
            clientMessageId: `production-${harness.pid}`,
          }),
        },
        cookie,
      );

      expect(denied.response.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain(harness.secret);
      expect(JSON.stringify(denied.body)).not.toContain(harness.databaseUrl);
    } finally {
      await stopProcess(server);
      server = await harness.startServer({ NODE_ENV: "test" });
    }
  },
  90_000,
);

test.skipIf(!backendEnabled)(
  "phase: database admission limits simultaneous runs",
  async () => {
    const cookieA = await harness.signup(email("admission-a"));
    const cookieB = await harness.signup(email("admission-b"));
    const cookieC = await harness.signup(email("admission-c"));

    if (dispatcher) await stopProcess(dispatcher);

    const first = await submitThread(cookieA, "admission first", `admission-first-${harness.pid}`);

    const sameUser = await harness.http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "same user is busy",
          clientMessageId: `admission-busy-${harness.pid}`,
        }),
      },
      cookieA,
    );

    expect(sameUser.response.status).toBe(409);

    const second = await submitThread(
      cookieB,
      "admission second",
      `admission-second-${harness.pid}`,
    );

    const overLimit = await harness.http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "admission over limit",
          clientMessageId: `admission-over-${harness.pid}`,
        }),
      },
      cookieC,
    );

    expect(overLimit.response.status).toBe(429);

    dispatcher = harness.startDispatcher();
    await waitForCompleted(cookieA, first.threadId, first.runId);
    await waitForCompleted(cookieB, second.threadId, second.runId);
  },
  180_000,
);

test.skipIf(!backendEnabled)(
  "phase: an undelivered follow-up protects a workspace from idle cleanup",
  async () => {
    const cookie = await harness.signup(email("outbox"));

    const initial = await submitThread(
      cookie,
      "prepare a reusable workspace",
      `outbox-initial-${harness.pid}`,
    );

    await harness.waitSnapshot(
      cookie,
      initial.threadId,
      (item) =>
        item.runs.some((run) => run.id === initial.runId && run.status === "completed") &&
        item.workspace?.state === "running",
      { timeoutMs: 60_000, label: "initial run and running workspace" },
    );
    await harness.waitSnapshot(
      cookie,
      initial.threadId,
      (item) => item.workspace?.state === "paused",
      { timeoutMs: 15_000, label: "workspace idle pause" },
    );

    if (dispatcher) await stopProcess(dispatcher);

    const followup = await submitMessage(
      cookie,
      initial.threadId,
      "continue while Temporal delivery is unavailable",
      `outbox-followup-${harness.pid}`,
    );

    const undelivered = await poll(
      () =>
        harness.query<{ delivered_at: Date | string | null }>(
          "select delivered_at from outbox where run_id = $1",
          [followup.runId],
        ),
      (rows) => rows.length === 1 && rows[0]?.delivered_at === null,
      { timeoutMs: 5_000, label: "follow-up outbox row to remain undelivered" },
    );

    expect(undelivered[0]?.delivered_at).toBeNull();
    await keepQueuedWhileCleanupRuns(cookie, initial.threadId, followup.runId);

    dispatcher = harness.startDispatcher();
    await waitForCompleted(cookie, initial.threadId, followup.runId);

    const delivered = await poll(
      () =>
        harness.query<{ delivered_at: Date | string | null }>(
          "select delivered_at from outbox where run_id = $1",
          [followup.runId],
        ),
      (rows) => rows.length === 1 && rows[0]?.delivered_at !== null,
      { timeoutMs: 30_000, label: "follow-up outbox delivery" },
    );

    expect(delivered[0]?.delivered_at).not.toBeNull();
  },
  180_000,
);

test.skipIf(!backendEnabled)(
  "phase: a worker crash leaves one durable command to reconcile",
  async () => {
    const cookie = await harness.signup(email("command-crash"));

    const submitted = await submitThread(
      cookie,
      "recover the accepted scripted command",
      `command-crash-${harness.pid}`,
    );

    // Catch the scripted workspace command (not the fast empty repository
    // init) while it is dispatched. The request text comes from the row so no
    // slow guest call happens until a scripted running row is observed: a
    // docker exec per sample would drop polling below the ~200ms window.
    // Dispatch is proven by the guest state file existing (any content); its
    // content races completion, so only existence gates the kill.
    const accepted = await poll(
      async () => {
        const rows = await harness.query<{
          command_id: string;
          workspace_id: string;
          name: string;
          state: string;
          generation: number;
          attempt_id: string;
          request_command: string | null;
        }>(
          "select co.command_id, co.workspace_id, w.name, co.state, co.generation, co.attempt_id, co.metadata->'request'->>'command' as request_command from command_operation co join workspace w on w.id = co.workspace_id where co.run_id = $1 order by co.created_at",
          [submitted.runId],
        );

        const operation = rows.find(
          (row) =>
            row.state === "running" &&
            row.request_command !== null &&
            row.request_command.includes("/workspace/runs/"),
        );

        if (!operation) return { operation: undefined, guestAccepted: false };

        const guest = await harness.command("docker", [
          "exec",
          operation.name,
          "cat",
          `/tmp/cloud-swe-commands/${operation.workspace_id}/${operation.command_id}/state`,
        ]);

        return { operation, guestAccepted: guest.code === 0 };
      },
      (value) => value.operation !== undefined && value.guestAccepted,
      { timeoutMs: 45_000, intervalMs: 25, label: "scripted command to be accepted by the guest" },
    );

    const acceptedOperation = accepted.operation;
    expect(acceptedOperation, "no running command operation was persisted").toBeDefined();
    const acceptedCommandId = acceptedOperation?.command_id;
    const acceptedWorkspaceId = acceptedOperation?.workspace_id;
    const acceptedGeneration = acceptedOperation?.generation;
    expect(acceptedCommandId).toBeTruthy();

    if (worker) await stopProcess(worker, "SIGKILL");
    worker = harness.startWorker();

    const completed = await waitForCompleted(cookie, submitted.threadId, submitted.runId, 90_000);
    const finalOperations = await harness.listRunCommands(submitted.runId);

    // A scripted run issues one fenced command per attempt for the empty
    // repository init. The scripted step runs once when its checkpoint saves;
    // a kill before the checkpoint saves re-runs the idempotent step only
    // after the old row reconciles to a settled state, so at most two rows.
    const scriptedOperations = finalOperations.filter((operation) => {
      const result = commandResultSchema.safeParse(operation.result).data;

      return result?.stdout.includes("scripted runner completed") ?? false;
    });

    expect(scriptedOperations.length).toBeLessThanOrEqual(2);
    expect(scriptedOperations.length).toBeGreaterThanOrEqual(1);

    for (const operation of finalOperations) expect(operation.state).toBe("completed");

    const recovered = finalOperations.find(
      (operation) => operation.command_id === acceptedCommandId,
    );

    // Reconciliation must reuse the accepted command identity, not dispatch a
    // concurrent second command. Same command_id, same workspace generation:
    // the guest-side fence plus the unsettled-generation unique index forbid
    // two mutating commands at once after a worker kill.
    expect(recovered, "accepted command identity was not reused after the crash").toBeDefined();
    expect(recovered?.workspace_id).toBe(acceptedWorkspaceId);
    expect(recovered?.generation).toBe(acceptedGeneration);
    expect(completed.workspace).not.toBeNull();

    if (!completed.workspace) throw new Error("completed run did not persist workspace metadata");

    for (const operation of finalOperations) {
      expect(operation.generation).toBe(completed.workspace.generation);
      expect(operation.attempt_id).toBeTruthy();
    }

    const workspaceName = completed.workspace.name;
    expect(workspaceName).toBeTruthy();

    if (!workspaceName) throw new Error("completed run did not persist a workspace name");

    const resultFile = await harness.command("docker", [
      "exec",
      workspaceName,
      "cat",
      `/workspace/runs/${submitted.runId}/result.txt`,
    ]);

    expect(resultFile.code, resultFile.stderr).toBe(0);
    expect(resultFile.stdout.trim()).toBe("scripted runner completed");

    // No concurrency: exactly one container owns this workspace name, no
    // unsettled commands remain for the generation, and the stored result is a
    // guest process result (status 0), not a transport ambiguity.
    const containers = await harness.command("docker", [
      "ps",
      "-a",
      "--filter",
      `name=^/${workspaceName}$`,
      "--format",
      "{{.Names}}",
    ]);

    expect(containers.code, containers.stderr).toBe(0);
    expect(containers.stdout.split("\n").filter(Boolean)).toHaveLength(1);

    if (!completed.workspace) throw new Error("completed run did not persist workspace metadata");

    const unsettled = await harness.listUnsettledWorkspaceCommands(
      completed.workspace.id,
      completed.workspace.generation,
    );

    expect(unsettled).toHaveLength(0);

    const scriptedOperation = finalOperations.find((operation) =>
      commandResultSchema
        .safeParse(operation.result)
        .data?.stdout.includes("scripted runner completed"),
    );

    expect(scriptedOperation, "scripted command result was not persisted").toBeDefined();
    const storedResult = commandResultSchema.parse(scriptedOperation?.result);
    expect(storedResult?.kind).toBe("completed");
    expect(storedResult?.statusCode).toBe(0);
  },
  240_000,
);

test.skipIf(!backendEnabled)(
  "phase: rebuilding a lost workspace increments its filesystem generation",
  async () => {
    const cookie = await harness.signup(email("generation"));

    const initial = await submitThread(
      cookie,
      "create a workspace generation",
      `generation-initial-${harness.pid}`,
    );

    const before = await harness.waitSnapshot(
      cookie,
      initial.threadId,
      (item) =>
        item.runs.some((run) => run.id === initial.runId && run.status === "completed") &&
        item.workspace?.state === "running",
      { timeoutMs: 60_000, label: "initial generation run" },
    );

    const oldWorkspace = before.workspace;
    expect(oldWorkspace).not.toBeNull();

    if (!oldWorkspace) throw new Error("initial run did not create a workspace");
    expect(oldWorkspace.generation).toBeGreaterThanOrEqual(1);
    const removed = await harness.command("docker", ["rm", "-f", oldWorkspace.name]);
    expect(removed.code, removed.stderr).toBe(0);

    const followup = await submitMessage(
      cookie,
      initial.threadId,
      "continue after the computer was replaced",
      `generation-followup-${harness.pid}`,
    );

    const after = await waitForCompleted(cookie, initial.threadId, followup.runId);
    expect(after.workspace).not.toBeNull();
    expect(after.workspace?.name).toBe(oldWorkspace.name);
    expect(after.workspace?.generation).toBeGreaterThan(oldWorkspace.generation);

    // Start after the initial run's completion: readSse stops at the first
    // wanted event, and the initial run.completed would hide the later reset.
    const events = await harness.readSse(
      cookie,
      initial.threadId,
      before.latestEventId ?? 0,
      new Set(["run.completed"]),
      {
        timeoutMs: 15_000,
      },
    );

    const reset = events.find(
      (event) => event.type === "workspace.rebuilt" || event.type === "workspace.reset",
    );

    expect(reset, "workspace replacement did not emit a durable reset event").toBeDefined();

    if (!reset) throw new Error("workspace replacement event was not found");
    const payload = reset.payload;
    expect(payload.oldGeneration ?? payload.previousGeneration).toBe(oldWorkspace.generation);
    expect(payload.newGeneration ?? payload.generation).toBe(after.workspace?.generation);
    const dataLossMessage = JSON.stringify(payload).toLowerCase();
    expect(dataLossMessage).toContain("uncommitted");
    expect(dataLossMessage).toContain("filesystem");
    expect(
      events.filter((event) => event.payload.runId === followup.runId).map((event) => event.type),
    ).toContain("run.completed");

    const recreated = await harness.command("docker", ["inspect", oldWorkspace.name]);
    expect(recreated.code, recreated.stderr).toBe(0);
  },
  180_000,
);

test.skipIf(!backendEnabled)(
  "phase: accepted runs survive Temporal and PostgreSQL restarts",
  async () => {
    const cookie = await harness.signup(email("service-restart"));
    const temporalStopped = await harness.command("docker", ["compose", "stop", "temporal"]);
    expect(temporalStopped.code, temporalStopped.stderr).toBe(0);

    const whileDown = await harness.http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "accepted while Temporal is down",
          clientMessageId: `temporal-down-${harness.pid}`,
        }),
      },
      cookie,
    );

    expect(whileDown.response.status).toBe(202);
    const temporalRun = resultSchema.parse(whileDown.body);

    const temporalStarted = await harness.command("docker", [
      "compose",
      "up",
      "-d",
      "--wait",
      "temporal",
    ]);

    expect(temporalStarted.code, temporalStarted.stderr).toBe(0);
    await waitForCompleted(cookie, temporalRun.threadId, temporalRun.runId, 90_000);

    const restarted = await harness.command("docker", ["compose", "restart", "postgres"]);
    expect(restarted.code, restarted.stderr).toBe(0);
    const ready = await harness.command("docker", ["compose", "up", "-d", "--wait", "postgres"]);
    expect(ready.code, ready.stderr).toBe(0);

    const afterPostgres = await poll(
      () =>
        harness.http(
          "/api/threads",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              prompt: "accepted after PostgreSQL restart",
              clientMessageId: `postgres-${harness.pid}`,
            }),
          },
          cookie,
        ),
      (response) => response.response.status === 202,
      { timeoutMs: 30_000, label: "submission after PostgreSQL reconnect" },
    );

    expect(afterPostgres.response.status).toBe(202);
    const postgresRun = resultSchema.parse(afterPostgres.body);
    await waitForCompleted(cookie, postgresRun.threadId, postgresRun.runId, 90_000);
  },
  240_000,
);

test.skipIf(!backendEnabled)(
  "phase: cancel before dispatch creates no workspace or command",
  async () => {
    const cookie = await harness.signup(email("cancel-before"));

    if (dispatcher) await stopProcess(dispatcher);

    const submitted = await submitThread(
      cookie,
      "cancel before the dispatcher can deliver",
      `cancel-before-${harness.pid}`,
    );

    // The run stays queued while Temporal delivery is stopped. Poll with a
    // bounded deadline: no workspace row and no command_operation row may
    // appear while the outbox signal is undelivered.
    await observeStable(
      async () => {
        const snapshot = await fetchSnapshot(cookie, submitted.threadId);
        const run = snapshot.runs.find((item) => item.id === submitted.runId);
        expect(run?.status).toBe("queued");
        expect(snapshot.workspace, "workspace created before dispatch").toBeNull();
        const workspaceRow = await harness.readWorkspaceRow(submitted.threadId);
        expect(workspaceRow, "workspace row created before dispatch").toBeUndefined();
        const commands = await harness.listRunCommands(submitted.runId);
        expect(commands, "command created before dispatch").toHaveLength(0);

        const outbox = await harness.query<{ delivered_at: Date | string | null }>(
          "select delivered_at from outbox where run_id = $1",
          [submitted.runId],
        );

        expect(outbox).toHaveLength(1);
        expect(outbox[0]?.delivered_at).toBeNull();
      },
      { durationMs: 3_000, intervalMs: 100, label: "queued run to create nothing before dispatch" },
    );

    const cancelled = await harness.http(
      `/api/threads/${submitted.threadId}/runs/${submitted.runId}/cancel`,
      { method: "POST" },
      cookie,
    );

    expect(cancelled.response.status).toBe(202);
    dispatcher = harness.startDispatcher();

    const terminal = await harness.waitSnapshot(
      cookie,
      submitted.threadId,
      (item) => item.runs.some((run) => run.id === submitted.runId && run.status === "cancelled"),
      { timeoutMs: 30_000, label: "queued cancellation before dispatch" },
    );

    expect(terminal.runs.find((run) => run.id === submitted.runId)?.status).toBe("cancelled");
    // Cancellation before dispatch must still create nothing: no workspace,
    // no command, no container. The dispatcher delivers the cancel signal to
    // a workflow that never prepared a workspace.
    expect(terminal.workspace).toBeNull();
    expect(await harness.readWorkspaceRow(submitted.threadId)).toBeUndefined();
    expect(await harness.listRunCommands(submitted.runId)).toHaveLength(0);

    const container = await harness.command("docker", [
      "ps",
      "-a",
      "--filter",
      `name=^/cloud-swe-${submitted.threadId}$`,
      "--format",
      "{{.Names}}",
    ]);

    expect(container.code, container.stderr).toBe(0);
    expect(container.stdout.trim()).toBe("");
  },
  120_000,
);

test.skipIf(!backendEnabled)(
  "phase: cancel after dispatch holds ownership until the command settles",
  async () => {
    const cookie = await harness.signup(email("cancel-after"));

    if (!dispatcher || dispatcher.exitCode !== null || dispatcher.signalCode !== null)
      dispatcher = harness.startDispatcher();

    const submitted = await submitThread(
      cookie,
      "cancel after the command is dispatched",
      `cancel-after-${harness.pid}`,
    );

    // Wait for dispatch: a workspace row, a command row, or a running run.
    // Polling with a bounded deadline, no fixed sleep.
    const dispatched = await poll(
      async () => {
        const snapshot = await fetchSnapshot(cookie, submitted.threadId);
        const workspaceRow = await harness.readWorkspaceRow(submitted.threadId);
        const commands = await harness.listRunCommands(submitted.runId);

        return { snapshot, workspaceRow, commands };
      },
      (value) =>
        value.workspaceRow !== undefined ||
        value.commands.length > 0 ||
        value.snapshot.runs.some((run) => run.id === submitted.runId && run.status === "running"),
      { timeoutMs: 45_000, intervalMs: 100, label: "run to dispatch a workspace or command" },
    );

    expect(
      dispatched.workspaceRow !== undefined ||
        dispatched.commands.length > 0 ||
        dispatched.snapshot.runs.some(
          (run) => run.id === submitted.runId && run.status === "running",
        ),
    ).toBe(true);

    const cancel = await harness.http(
      `/api/threads/${submitted.threadId}/runs/${submitted.runId}/cancel`,
      { method: "POST" },
      cookie,
    );

    expect(cancel.response.status).toBe(202);

    // The cancel request is recorded immediately; the workflow reconciles the
    // dispatched command before releasing ownership (same path as a run
    // timeout: cancellationRequested + guest reconcile, never abandon).
    const requested = await harness.waitSnapshot(
      cookie,
      submitted.threadId,
      (item) =>
        item.runs.some((run) => run.id === submitted.runId && run.cancelRequestedAt !== null) ||
        item.runs.some((run) => run.id === submitted.runId && run.status === "cancelled"),
      { timeoutMs: 15_000, label: "cancel request to be recorded" },
    );

    expect(
      requested.runs.find((run) => run.id === submitted.runId)?.cancelRequestedAt ??
        requested.runs.find((run) => run.id === submitted.runId)?.status,
    ).toBeTruthy();

    const terminal = await harness.waitSnapshot(
      cookie,
      submitted.threadId,
      (item) =>
        item.runs.some(
          (run) => run.id === submitted.runId && ["cancelled", "failed"].includes(run.status),
        ),
      { timeoutMs: 90_000, label: "cancelled run to settle" },
    );

    const finalRun = terminal.runs.find((run) => run.id === submitted.runId);
    expect(["cancelled", "failed"].includes(finalRun?.status ?? "")).toBe(true);
    // Ownership held: at most the two fenced commands of a scripted run
    // (empty repository init plus the scripted command), no concurrent retry,
    // the workspace was not deleted out from under the run, and no unsettled
    // commands remain for the final generation.
    const commands = await harness.listRunCommands(submitted.runId);
    expect(commands.length).toBeLessThanOrEqual(2);

    for (const command of commands) {
      expect(["completed", "failed"].includes(command?.state ?? "")).toBe(true);
    }

    expect(terminal.workspace, "cancel after dispatch deleted the workspace").not.toBeNull();
    expect(terminal.workspace?.state).not.toBe("deleted");

    if (terminal.workspace) {
      const unsettled = await harness.listUnsettledWorkspaceCommands(
        terminal.workspace.id,
        terminal.workspace.generation,
      );

      expect(unsettled).toHaveLength(0);
    }
  },
  180_000,
);

test.skipIf(!backendEnabled)(
  "phase: provider outcomes stay distinct and spaces paths work on real workspaces",
  async () => {
    const cookie = await harness.signup(email("provider-spaces"));

    const submitted = await submitThread(
      cookie,
      "prove provider distinctions on a real container",
      `provider-spaces-${harness.pid}`,
    );

    const completed = await waitForCompleted(cookie, submitted.threadId, submitted.runId);
    expect(completed.workspace).not.toBeNull();

    if (!completed.workspace) throw new Error("completed run did not persist a workspace");
    const workspaceName = completed.workspace.name;
    // The durable command rows for the real Docker run are guest process
    // results (status 0): the empty repository init plus the scripted command.
    // Both stay distinct from transport/timeout/cancel/unknown outcomes.
    const commands = await harness.listRunCommands(submitted.runId);
    expect(commands).toHaveLength(2);

    for (const command of commands) {
      const stored = commandResultSchema.parse(command.result);
      expect(command?.state).toBe("completed");
      expect(stored?.kind).toBe("completed");
      expect(stored?.statusCode).toBe(0);
    }

    // Pure-function contract, bound to the same helpers the worker uses:
    // nonzero stays a tool result; timeout/cancel/unknown/output-limit stay
    // distinct transport outcomes with null status codes.
    expect(normalizePiCommandResult(processResult("out", "", 0), 128).kind).toBe("completed");
    expect(normalizePiCommandResult(processResult("out", "err", 7), 128).kind).toBe("nonzero");
    expect(normalizePiCommandResult(processResult("abcdefgh", "ijkl", 1), 5).kind).toBe(
      "output-limit",
    );
    expect(
      normalizePiCommandResult(transportResult("transport-timeout", "deadline"), 128).kind,
    ).toBe("transport-timeout");
    expect(normalizePiCommandResult(transportResult("cancelled", "stopped"), 128).kind).toBe(
      "cancelled",
    );
    expect(normalizePiCommandResult(transportResult("unknown", "lost"), 128).kind).toBe("unknown");
    // Spaces path through the real guest fence: build the same remote_write
    // command Pi uses, pipe file content on stdin into the real workspace
    // container (`cat > <path>`), then read it back. Quoting must survive spaces.
    const spacedPath = "nested directory/file name.txt";
    const spacedContent = `spaces-path-${harness.pid}`;
    const writeCommand = buildRemoteWriteCommand(spacedPath);

    const write = await harness.commandWithStdin(
      "docker",
      ["exec", "-i", workspaceName, "sh", "-lc", writeCommand],
      spacedContent,
    );

    expect(write.code, write.stderr).toBe(0);

    const readBack = await harness.command("docker", [
      "exec",
      workspaceName,
      "cat",
      `--`,
      `/workspace/${spacedPath}`,
    ]);

    expect(readBack.code, readBack.stderr).toBe(0);
    expect(readBack.stdout).toBe(spacedContent);
  },
  120_000,
);

test.skipIf(!backendEnabled)(
  "phase: Pi boundary uses only custom remote tools (no paid calls)",
  async () => {
    // Hermetic boundary check inside the backend suite: Pi must only receive
    // remote_exec/remote_read/remote_write and an empty resource loader, so
    // it can never operate on the worker filesystem via bash/read/edit.
    // No Freestyle VM, no model call, no credentials leave the worker.
    expect([...PI_TOOL_NAMES]).toEqual([
      "remote_exec",
      "remote_read",
      "remote_write",
      "remote_edit",
    ]);
    const loader = createPiResourceLoader();
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getSystemPrompt()).toBeUndefined();
  },
  30_000,
);
