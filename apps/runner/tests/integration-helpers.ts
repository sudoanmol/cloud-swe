import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { QueryResultRow } from "pg";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as dbSchema from "@cloud-swe/db/schema/index";
import { createThreadStore } from "@cloud-swe/db/threads";
import type { ThreadStore } from "@cloud-swe/db/thread-contracts";
import { z } from "zod";
import type { JsonObject } from "@cloud-swe/db/json";

const root = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

const tsxLoader = "./apps/runner/node_modules/tsx/dist/loader.mjs";

export const resultSchema = z.object({ threadId: z.uuid(), runId: z.uuid() });

export const snapshotSchema = z.object({
  id: z.uuid(),
  repositoryUrl: z.string().nullable(),
  repositoryBranch: z.string().nullable(),
  messages: z.array(
    z.object({
      id: z.uuid(),
      role: z.string(),
      content: z.string(),
      runId: z.string().nullable().optional(),
    }),
  ),
  runs: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
      cancelRequestedAt: z.string().nullable().optional(),
      error: z.string().nullable().optional(),
    }),
  ),
  workspace: z
    .object({
      id: z.uuid(),
      name: z.string(),
      provider: z.enum(["docker", "freestyle"]),
      providerId: z.string().nullable(),
      generation: z.number().int().positive(),
      state: z.string(),
    })
    .nullable(),
  latestEventId: z.number().int().nonnegative().nullable(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

export type IntegrationEvent = {
  id: string;
  type: string;
  payload: JsonObject;
};

export type CommandResult = { code: number; stdout: string; stderr: string };

export type PollOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
};

/** Kill-switch: SKIP_BACKEND_TESTS=1 skips the real Docker + Temporal + disposable Postgres phases. */
export const BACKEND_TESTS_ENABLED = process.env.SKIP_BACKEND_TESTS !== "1";

export const BACKEND_SKIP_REASON =
  "Backend integration tests skipped: set SKIP_BACKEND_TESTS=1 (or unset it to run against real local Docker + Temporal + disposable Postgres)";

export type CommandOperationRow = {
  command_id: string;
  workspace_id: string;
  workspace_name?: string;
  generation: number;
  run_id: string;
  attempt_id: string;
  state: string;
  cancellation_requested: boolean;
  result: unknown;
};

export type WorkspaceRow = {
  id: string;
  thread_id: string;
  name: string;
  provider: string;
  provider_id: string | null;
  generation: number;
  state: string;
};

export type HarnessOptions = {
  portBase?: number;
  executionMode?: "scripted" | "pi";
  sandboxProvider?: "docker" | "freestyle";
  idlePauseMs?: number;
  cleanupMs?: number;
  stepDelayMs?: number;
  maxRunMs?: number;
  maxActiveRuns?: number;
  freestyleApiKey?: string;
  freestyleSnapshotId?: string;
  freestyleIdleTimeoutSeconds?: string;
  freestyleAutoDeleteSeconds?: string;
  aiGatewayApiKey?: string;
  dbName?: string;
};

function processTail(tails: Map<ChildProcess, string>, child: ChildProcess): string {
  return tails.get(child) ?? "";
}

export async function poll<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: PollOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 200;
  const label = options.label ?? "condition";
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      lastValue = await read();

      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }

    const remaining = deadline - Date.now();

    if (remaining <= 0) break;
    await Bun.sleep(Math.min(intervalMs, remaining));
  }

  const diagnostic = lastError
    ? `; last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : lastValue === undefined
      ? ""
      : `; last value: ${JSON.stringify(lastValue)}`;

  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms${diagnostic}`);
}

/**
 * Assert a condition stays true for a bounded observation window using polling.
 * Used for "creates nothing" phases (cancel before dispatch must not create a
 * workspace or command_operation row). This is polling with a deadline, not a
 * fixed sleep: the assertion runs every intervalMs and fails fast on violation.
 */
export async function observeStable(
  check: () => Promise<void>,
  options: PollOptions & { durationMs?: number } = {},
): Promise<{ observations: number }> {
  const durationMs = options.durationMs ?? options.timeoutMs ?? 3_000;
  const intervalMs = options.intervalMs ?? 100;
  const label = options.label ?? "stable condition";
  const deadline = Date.now() + durationMs;
  let observations = 0;

  while (Date.now() < deadline) {
    try {
      await check();
    } catch (error) {
      throw new Error(
        `Stable condition failed (${label}) after ${observations} observations: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    observations += 1;
    const remaining = deadline - Date.now();

    if (remaining <= 0) break;
    await Bun.sleep(Math.min(intervalMs, remaining));
  }

  if (observations < 2)
    throw new Error(
      `Stable condition (${label}) observed only ${observations}x; increase durationMs`,
    );

  return { observations };
}

export async function waitForPort(
  host: string,
  port: number,
  options: PollOptions = {},
): Promise<void> {
  await poll(
    async () =>
      await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host, port });

        const close = (ready: boolean) => {
          socket.destroy();
          resolve(ready);
        };

        socket.once("connect", () => close(true));
        socket.once("error", () => close(false));
      }),
    (ready) => ready,
    { label: `TCP ${host}:${port}`, ...options },
  );
}

export async function stopProcess(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals = "SIGTERM",
  timeoutMs = 5_000,
): Promise<void> {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) return;

  if (child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      child.removeListener("close", finish);
      resolve();
    };

    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      setTimeout(finish, timeoutMs);
    }, timeoutMs);

    child.once("close", finish);
    child.kill(signal);
  });
}

export function createIntegrationHarness(options: HarnessOptions = {}) {
  const pid = process.pid;
  const dbName = options.dbName ?? `cloud_swe_e2e_${pid}`;

  const port = Number(
    process.env.BACKEND_TEST_PORT ?? (options.portBase ?? 31_000) + (pid % 1_000),
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = `postgresql://postgres:password@127.0.0.1:5432/${dbName}`;
  const secret = `e2e-${randomBytes(24).toString("hex")}`;
  const executionMode = options.executionMode ?? "scripted";
  const sandboxProvider = options.sandboxProvider ?? "docker";
  const children = new Set<ChildProcess>();
  const threadIds = new Set<string>();
  const containers = new Set<string>();
  const tails = new Map<ChildProcess, string>();
  let dbPool: Pool | undefined;

  const runtimeEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: baseUrl,
    CORS_ORIGIN: baseUrl,
    NODE_ENV: "test",
    ALLOW_UNVERIFIED_COMPUTE: "true",
    RUNNER_EXECUTION_MODE: executionMode,
    RUNNER_SANDBOX_PROVIDER: sandboxProvider,
    RUNNER_IDLE_PAUSE_MS: String(options.idlePauseMs ?? 1_000),
    RUNNER_CLEANUP_MS: String(options.cleanupMs ?? 3_000),
    RUNNER_MAX_RUN_MS: String(options.maxRunMs ?? 30_000),
    RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS: "60000",
    RUNNER_PROVIDER_TIMEOUT_MS: "5000",
    RUNNER_COMMAND_RECONCILE_TIMEOUT_MS: "5000",
    RUNNER_ACTIVITY_RETRY_MAX_ATTEMPTS: "3",
    RUNNER_ACTIVITY_RETRY_WINDOW_MS: String(
      Math.max(240_000, Math.max(60_000, (options.maxRunMs ?? 30_000) + 5_000) * 3 + 30_000),
    ),
    RUNNER_STEP_DELAY_MS: String(options.stepDelayMs ?? 100),
    RUNNER_ACTIVITY_CONCURRENCY: "4",
    RUNNER_REPOSITORY_CLONE_TIMEOUT_MS: "15000",
    RUNNER_REPOSITORY_MAX_BYTES: "4294967296",
    RUNNER_REPOSITORY_MIN_FREE_BYTES: "1",
    RUNNER_COMMAND_OUTPUT_MAX_BYTES: "262144",
    RUNNER_CHECKPOINT_MAX_BYTES: "4194304",
    RUNNER_DOCKER_IMAGE: "cloud-swe-local-tests",
    PI_PROVIDER: "vercel-ai-gateway",
    PI_MODEL: "meta/muse-spark-1.3-contributor",
    MAX_ACTIVE_RUNS: String(options.maxActiveRuns ?? 2),
    SSE_POLL_MS: "50",
    SSE_HEARTBEAT_MS: "500",
    FREESTYLE_SNAPSHOT_ID:
      options.freestyleSnapshotId ?? process.env.FREESTYLE_SNAPSHOT_ID ?? "freestyle/ubuntu-sm",
    FREESTYLE_IDLE_TIMEOUT_SECONDS: options.freestyleIdleTimeoutSeconds ?? "-1",
    FREESTYLE_AUTO_DELETE_SECONDS: options.freestyleAutoDeleteSeconds ?? "14400",
  };

  if (options.freestyleApiKey) runtimeEnv.FREESTYLE_API_KEY = options.freestyleApiKey;

  if (options.aiGatewayApiKey) runtimeEnv.AI_GATEWAY_API_KEY = options.aiGatewayApiKey;

  function start(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        ...runtimeEnv,
        ...extraEnv,
        SKIP_ENV_VALIDATION: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    children.add(child);
    tails.set(child, "");

    const capture = (part: Buffer) => {
      tails.set(child, `${tails.get(child) ?? ""}${part.toString()}`.slice(-8_000));
    };

    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    return child;
  }

  async function command(
    executable: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
    timeoutMs = 30_000,
  ): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        env: { ...process.env, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout?.on("data", (part: Buffer) => (stdout += part.toString()));
      child.stderr?.on("data", (part: Buffer) => (stderr += part.toString()));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({
          code: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr,
        });
      });
    });
  }

  async function http(path: string, init: RequestInit = {}, cookie?: string) {
    const headers = new Headers(init.headers);

    if (cookie) headers.set("cookie", cookie);
    const method = (init.method ?? "GET").toUpperCase();

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (!headers.has("origin")) headers.set("origin", baseUrl);

      if (!headers.has("x-csrf-protection")) headers.set("x-csrf-protection", "1");
    }

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    let body: unknown = text;

    try {
      body = JSON.parse(text);
    } catch {
      // Some framework errors are plain text.
    }

    const accepted = resultSchema.safeParse(body);

    if (response.status === 202 && accepted.success) {
      threadIds.add(accepted.data.threadId);
      containers.add(`cloud-swe-${accepted.data.threadId}`);
    }

    return {
      response,
      body,
      text,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }

  async function signup(email: string, password = "A-valid-password-123!") {
    const result = await http("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: email.split("@")[0], email, password }),
    });

    if (!result.response.ok || !result.cookie)
      throw new Error(`signup failed: ${result.response.status} ${result.text}`);

    return result.cookie;
  }

  async function waitSnapshot(
    cookie: string,
    threadId: string,
    predicate: (snapshot: Snapshot) => boolean,
    pollOptions: PollOptions = {},
  ): Promise<Snapshot> {
    return await poll(
      async () => {
        const result = await http(`/api/threads/${threadId}`, {}, cookie);

        if (!result.response.ok)
          throw new Error(`snapshot failed: ${result.response.status} ${result.text}`);

        return snapshotSchema.parse(result.body);
      },
      predicate,
      { label: `thread ${threadId} snapshot`, ...pollOptions },
    );
  }

  async function readSse(
    cookie: string,
    threadId: string,
    after?: string | number,
    wanted: Set<string> = new Set(),
    options: PollOptions = {},
  ): Promise<IntegrationEvent[]> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers({ accept: "text/event-stream", cookie });
    const query = after === undefined ? "" : `?after=${encodeURIComponent(String(after))}`;

    const response = await fetch(`${baseUrl}/api/threads/${threadId}/events${query}`, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok || !response.body)
      throw new Error(`SSE failed: ${response.status} ${await response.text()}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: IntegrationEvent[] = [];

    try {
      while (true) {
        const part = await reader.read();

        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const id = chunk.match(/^id: (.+)$/m)?.[1];
          const type = chunk.match(/^event: (.+)$/m)?.[1];
          const data = chunk.match(/^data: (.+)$/m)?.[1];

          if (!id || !type || !data) continue;
          const payload = z.record(z.string(), z.json()).parse(JSON.parse(data));
          const event = { id, type, payload };
          events.push(event);

          if (wanted.has(type)) {
            clearTimeout(timer);
            controller.abort();

            return events;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    return events;
  }

  function createStore(): ThreadStore {
    dbPool ??= new Pool({ connectionString: databaseUrl, max: 4 });

    return createThreadStore(drizzle(dbPool, { schema: dbSchema }));
  }

  async function query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    dbPool ??= new Pool({ connectionString: databaseUrl, max: 4 });
    const result = await dbPool.query<T>(text, values);

    return result.rows;
  }

  async function listRunCommands(runId: string): Promise<CommandOperationRow[]> {
    return query<CommandOperationRow>(
      "select co.command_id, co.workspace_id, w.name as workspace_name, co.generation, co.run_id, co.attempt_id, co.state, co.cancellation_requested, co.result from command_operation co left join workspace w on w.id = co.workspace_id where co.run_id = $1 order by co.created_at",
      [runId],
    );
  }

  async function listUnsettledWorkspaceCommands(
    workspaceId: string,
    generation: number,
  ): Promise<CommandOperationRow[]> {
    return query<CommandOperationRow>(
      "select command_id, workspace_id, generation, run_id, attempt_id, state, cancellation_requested, result from command_operation where workspace_id = $1 and generation = $2 and state in ('pending', 'running', 'unknown') order by created_at",
      [workspaceId, generation],
    );
  }

  async function readWorkspaceRow(threadId: string): Promise<WorkspaceRow | undefined> {
    const rows = await query<WorkspaceRow>(
      "select id, thread_id, name, provider, provider_id, generation, state from workspace where thread_id = $1",
      [threadId],
    );

    return rows[0];
  }

  /**
   * Run a local process with piped stdin (e.g. `docker exec -i <container>`).
   * Needed for remote_write parity: buildRemoteWriteCommand consumes file
   * content on stdin (`cat > <path>`), so spaces-path verification must pipe
   * content rather than passing it as an argv/env value.
   */
  async function commandWithStdin(
    executable: string,
    args: string[],
    input: string,
    timeoutMs = 30_000,
  ): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout?.on("data", (part: Buffer) => (stdout += part.toString()));
      child.stderr?.on("data", (part: Buffer) => (stderr += part.toString()));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    });
  }

  async function startServer(extraEnv: NodeJS.ProcessEnv = {}) {
    const child = start("node", ["--import", tsxLoader, "apps/server/src/index.ts"], {
      PORT: String(port),
      HOST: "127.0.0.1",
      ...extraEnv,
    });

    await waitForPort("127.0.0.1", port, {
      timeoutMs: 30_000,
      label: `backend server port ${port}`,
    }).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${processTail(tails, child)}`,
      );
    });

    return child;
  }

  function startWorker(extraEnv: NodeJS.ProcessEnv = {}) {
    return start("node", ["--import", tsxLoader, "apps/runner/src/index.ts", "worker"], {
      TEMPORAL_TASK_QUEUE: `e2e-${pid}`,
      ...extraEnv,
    });
  }

  function startDispatcher(extraEnv: NodeJS.ProcessEnv = {}) {
    return start("node", ["--import", tsxLoader, "apps/runner/src/index.ts", "dispatcher"], {
      TEMPORAL_TASK_QUEUE: `e2e-${pid}`,
      ...extraEnv,
    });
  }

  async function setup() {
    if (sandboxProvider === "docker") {
      const image = await command("docker", [
        "build",
        "-t",
        "cloud-swe-local-tests",
        "-f",
        "apps/runner/tests/Dockerfile",
        ".",
      ]);

      if (image.code !== 0) throw new Error(`could not build local test image: ${image.stderr}`);
    }

    const infra = await command("docker", [
      "compose",
      "up",
      "-d",
      "--wait",
      "postgres",
      "temporal",
    ]);

    if (infra.code !== 0) throw new Error(`local infrastructure is unavailable: ${infra.stderr}`);

    const created = await command("docker", [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `CREATE DATABASE ${dbName}`,
    ]);

    if (created.code !== 0) throw new Error(`could not create test DB: ${created.stderr}`);

    const migrated = await command(
      "bun",
      ["run", "--cwd", "packages/db", "db:migrate"],
      runtimeEnv,
    );

    if (migrated.code !== 0) throw new Error(`migration failed: ${migrated.stderr}`);
    const server = await startServer();
    const worker = startWorker();
    const dispatcher = startDispatcher();

    return { server, worker, dispatcher };
  }

  async function cleanup() {
    for (const child of children) await stopProcess(child);
    await command("docker", ["compose", "up", "-d", "--wait", "postgres", "temporal"]);

    for (const threadId of threadIds) {
      await command("docker", [
        "compose",
        "exec",
        "-T",
        "temporal",
        "temporal",
        "workflow",
        "terminate",
        "--workflow-id",
        `thread:${threadId}`,
        "--reason",
        "Backend integration test cleanup",
      ]);
    }

    for (const name of containers) await command("docker", ["rm", "-f", name]);
    await dbPool?.end();
    dbPool = undefined;
    await command("docker", [
      "compose",
      "exec",
      "-T",
      "postgres",
      "dropdb",
      "--if-exists",
      "--force",
      "--username=postgres",
      dbName,
    ]);
  }

  return {
    root,
    pid,
    dbName,
    port,
    baseUrl,
    databaseUrl,
    secret,
    runtimeEnv,
    children,
    threadIds,
    containers,
    tails,
    command,
    http,
    signup,
    waitSnapshot,
    readSse,
    createStore,
    query,
    listRunCommands,
    listUnsettledWorkspaceCommands,
    readWorkspaceRow,
    commandWithStdin,
    startServer,
    startWorker,
    startDispatcher,
    setup,
    cleanup,
  };
}
