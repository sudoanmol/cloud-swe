import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { z } from "zod";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const pid = process.pid;
const dbName = `cloud_swe_e2e_${pid}`;
const port = Number(process.env.BACKEND_TEST_PORT ?? 31_000 + (pid % 1_000));
const databaseUrl = `postgresql://postgres:password@127.0.0.1:5432/${dbName}`;
const baseUrl = `http://127.0.0.1:${port}`;
const secret = `e2e-${randomBytes(24).toString("hex")}`;
const emailA = `e2e-${pid}-a@example.com`;
const emailB = `e2e-${pid}-b@example.com`;
const password = "A-valid-password-123!";
const testRuntimeEnv = {
  DATABASE_URL: databaseUrl,
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: baseUrl,
  CORS_ORIGIN: baseUrl,
  NODE_ENV: "test",
};
const children: ChildProcess[] = [];
const containers = new Set<string>();
const tsxLoader = "./apps/runner/node_modules/tsx/dist/loader.mjs";

const resultSchema = z.object({ threadId: z.uuid(), runId: z.uuid() });
const snapshotSchema = z.object({
  id: z.uuid(),
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
    }),
  ),
  workspace: z.object({ id: z.uuid(), dockerName: z.string(), state: z.string() }).nullable(),
  latestEventId: z.string().nullable(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
const threadIds = new Set<string>();
const outputTails = new Map<ChildProcess, string>();
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill(signal);
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(force);
}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function command(command: string, args: string[], env: Record<string, string> = {}) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (part) => (stdout += part));
    child.stderr?.on("data", (part) => (stderr += part));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function start(command: string, args: string[], extraEnv: Record<string, string> = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      RUNNER_STEP_DELAY_MS: "1000",
      RUNNER_IDLE_PAUSE_MS: "2000",
      RUNNER_CLEANUP_MS: "4000",
      ...extraEnv,
      ...testRuntimeEnv,
      SKIP_ENV_VALIDATION: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  outputTails.set(child, "");
  const capture = (part: Buffer) =>
    outputTails.set(child, ((outputTails.get(child) ?? "") + part.toString()).slice(-6000));
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return child;
}

async function waitForPort(host: string, targetPort: number, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port: targetPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${host}:${targetPort}`);
}

async function http(path: string, init: RequestInit = {}, cookie?: string) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(10000),
    ...init,
    headers,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  const accepted = resultSchema.safeParse(body);
  if (response.status === 202 && accepted.success) {
    threadIds.add(accepted.data.threadId);
    containers.add(`cloud-swe-${accepted.data.threadId}`);
  }
  return { response, body, text, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

async function signup(email: string) {
  const result = await http("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ name: email.split("@")[0], email, password }),
  });
  check(result.response.ok, `signup failed: ${result.response.status} ${result.text}`);
  check(result.cookie, "signup did not return a session cookie");
  return result.cookie;
}

async function waitSnapshot(
  cookie: string,
  threadId: string,
  predicate: (snapshot: Snapshot) => boolean,
  timeout = 30_000,
) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await http(`/api/threads/${threadId}`, {}, cookie);
    check(result.response.ok, `snapshot failed: ${result.response.status} ${result.text}`);
    const snapshot = snapshotSchema.parse(result.body);
    if (predicate(snapshot)) return snapshot;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for thread ${threadId}`);
}

async function readSse(
  cookie: string,
  threadId: string,
  after: string | undefined,
  wanted: Set<string>,
  timeout = 30_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = new Headers({ accept: "text/event-stream" });
  if (cookie) headers.set("cookie", cookie);
  if (after) headers.set("last-event-id", after);
  const response = await fetch(`${baseUrl}/api/threads/${threadId}/events`, {
    headers,
    signal: controller.signal,
  });
  check(response.ok && response.body, `SSE failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ id: string; type: string; payload: Record<string, unknown> }> = [];
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
        const event = {
          id,
          type,
          payload: z.record(z.string(), z.unknown()).parse(JSON.parse(data)),
        };
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
    reader.releaseLock();
  }
  return events;
}

async function main() {
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
  check(created.code === 0, `could not create test DB: ${created.stderr}`);
  const migrated = await command("bun", ["run", "--cwd", "packages/db", "db:migrate"], {
    ...testRuntimeEnv,
  });
  check(migrated.code === 0, `migration failed: ${migrated.stderr}`);

  let server = start("node", ["--import", tsxLoader, "apps/server/src/index.ts"], {
    PORT: String(port),
    HOST: "127.0.0.1",
  });
  await waitForPort("127.0.0.1", port);
  let worker = start("node", ["--import", tsxLoader, "apps/runner/src/index.ts", "worker"], {
    TEMPORAL_TASK_QUEUE: `e2e-${pid}`,
    RUNNER_DOCKER_IMAGE: "ubuntu:24.04",
  });
  let dispatcher = start(
    "node",
    ["--import", tsxLoader, "apps/runner/src/index.ts", "dispatcher"],
    {
      TEMPORAL_TASK_QUEUE: `e2e-${pid}`,
    },
  );

  const unauth = await http("/api/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x", clientMessageId: "unauth" }),
  });
  check(
    unauth.response.status === 401,
    `unauthenticated request returned ${unauth.response.status}`,
  );
  const cookieA = await signup(emailA);
  const cookieB = await signup(emailB);
  const cookieC = await signup(`e2e-${pid}-c@example.com`);
  const body = { prompt: "fixed script", clientMessageId: `message-${pid}` };
  const concurrent = await Promise.all([
    http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      cookieA,
    ),
    http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      cookieA,
    ),
  ]);
  check(
    concurrent.every((item) => item.response.status === 202),
    `concurrent idempotent submit failed: ${concurrent.map((item) => item.response.status)}`,
  );
  const result = resultSchema.parse(concurrent[0]?.body);
  check(
    JSON.stringify(concurrent[0]?.body) === JSON.stringify(concurrent[1]?.body),
    "idempotent requests returned different IDs",
  );
  // The request is durable before dispatch, so an API restart cannot lose the accepted run.
  await stop(server);
  server = start("node", ["--import", tsxLoader, "apps/server/src/index.ts"], {
    PORT: String(port),
    HOST: "127.0.0.1",
  });
  await waitForPort("127.0.0.1", port);

  const conflict = await http(
    "/api/threads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, prompt: "different" }),
    },
    cookieA,
  );
  check(
    conflict.response.status === 409 &&
      z.object({ error: z.object({ code: z.string() }) }).parse(conflict.body).error.code ===
        "IDEMPOTENCY_CONFLICT",
    "conflicting retry was not rejected",
  );
  const crossUser = await http(`/api/threads/${result.threadId}`, {}, cookieB);
  check(
    crossUser.response.status === 404,
    `cross-user snapshot returned ${crossUser.response.status}`,
  );

  const [firstEvents, secondEvents] = await Promise.all([
    readSse(cookieA, result.threadId, undefined, new Set(["run.completed"])),
    readSse(cookieA, result.threadId, undefined, new Set(["run.completed"])),
  ]);
  check(
    JSON.stringify(firstEvents.map((event) => event.id)) ===
      JSON.stringify(secondEvents.map((event) => event.id)),
    "two SSE readers observed different ordered histories",
  );
  check(
    firstEvents.some(
      (event) =>
        event.type === "tool.output" &&
        typeof event.payload.output === "string" &&
        event.payload.output.includes("scripted runner completed"),
    ),
    "SSE did not expose scripted tool output",
  );
  const sequences = firstEvents.map((event) => Number(event.id));
  check(
    sequences.every((value, index) => index === 0 || value > (sequences[index - 1] ?? 0)),
    "SSE event IDs were not ordered",
  );
  const latest = sequences.at(-1);
  check(latest !== undefined, "SSE returned no events");
  const snapshot = await waitSnapshot(cookieA, result.threadId, (item) =>
    item.runs.some((run) => run.status === "completed"),
  );
  check(snapshot.runs.filter((run) => run.id === result.runId).length === 1, "run duplicated");
  const resumedEvents = await readSse(
    cookieA,
    result.threadId,
    String(latest),
    new Set(["run.queued"]),
    2_000,
  );
  check(
    resumedEvents.every((event) => Number(event.id) > latest),
    "cursor replayed an already-consumed event",
  );

  // An accepted request remains durable while the dispatcher is unavailable, and cancellation
  // can be requested before Temporal ever receives the run.
  await stop(dispatcher);
  const queued = await http(
    "/api/threads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "cancel before dispatch", clientMessageId: `queued-${pid}` }),
    },
    cookieB,
  );
  check(queued.response.status === 202, `queued submit failed: ${queued.response.status}`);
  const queuedRun = resultSchema.parse(queued.body);
  const cancel = await http(
    `/api/threads/${queuedRun.threadId}/runs/${queuedRun.runId}/cancel`,
    { method: "POST" },
    cookieB,
  );
  check(cancel.response.status === 202, `queued cancellation failed: ${cancel.response.status}`);
  dispatcher = start("node", ["--import", tsxLoader, "apps/runner/src/index.ts", "dispatcher"], {
    TEMPORAL_TASK_QUEUE: `e2e-${pid}`,
  });
  const cancelledSnapshot = await waitSnapshot(
    cookieB,
    queuedRun.threadId,
    (item) => item.runs[0]?.status === "cancelled",
  );
  check(cancelledSnapshot.runs[0]?.status === "cancelled", "queued run did not become cancelled");

  {
    const crashRequest = await http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "worker crash recovery", clientMessageId: `crash-${pid}` }),
      },
      cookieB,
    );
    check(crashRequest.response.status === 202, "crash recovery submit failed");
    const crashRun = resultSchema.parse(crashRequest.body);
    const beforeCrash = await readSse(
      cookieB,
      crashRun.threadId,
      undefined,
      new Set(["assistant.delta"]),
    );
    check(
      beforeCrash.some((event) => event.type === "assistant.delta"),
      "run did not reach checkpointed output before crash",
    );
    await stop(worker, "SIGKILL");
    worker = start("node", ["--import", tsxLoader, "apps/runner/src/index.ts", "worker"], {
      TEMPORAL_TASK_QUEUE: `e2e-${pid}`,
      RUNNER_DOCKER_IMAGE: "ubuntu:24.04",
    });
    const recovered = await waitSnapshot(
      cookieB,
      crashRun.threadId,
      (item) => item.runs[0]?.status === "completed",
      60_000,
    );
    check(
      recovered.runs.filter((run) => run.id === crashRun.runId).length === 1,
      "recovered run duplicated",
    );

    check(
      recovered.messages.filter((message) => message.role === "assistant").length === 1,
      "recovery duplicated final assistant message",
    );
    const crashEvents = await readSse(
      cookieB,
      crashRun.threadId,
      undefined,
      new Set(["run.completed"]),
    );
    check(
      crashEvents.filter((event) => event.type === "run.completed").length === 1,
      "recovery duplicated terminal event",
    );
    check(
      crashEvents.filter((event) => event.type === "assistant.delta").length === 3,
      "recovery duplicated or lost response chunks",
    );
    const runningRequest = await http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "cancel while running",
          clientMessageId: `running-cancel-${pid}`,
        }),
      },
      cookieB,
    );
    check(runningRequest.response.status === 202, "running cancellation submit failed");
    const runningRun = resultSchema.parse(runningRequest.body);
    await waitSnapshot(cookieB, runningRun.threadId, (item) => item.runs[0]?.status === "running");
    const runningCancel = await http(
      `/api/threads/${runningRun.threadId}/runs/${runningRun.runId}/cancel`,
      { method: "POST" },
      cookieB,
    );
    check(runningCancel.response.status === 202, "running cancellation request failed");
    const cancelledRunning = await waitSnapshot(
      cookieB,
      runningRun.threadId,
      (item) => item.runs[0]?.status === "cancelled",
    );
    check(cancelledRunning.runs[0]?.status === "cancelled", "running run was not cancelled");

    const saturatedA = await http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "admission one", clientMessageId: `admission-a-${pid}` }),
      },
      cookieA,
    );
    const sameUserBusy = await http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "same user busy", clientMessageId: `busy-${pid}` }),
      },
      cookieA,
    );
    check(
      sameUserBusy.response.status === 409,
      `same-user admission returned ${sameUserBusy.response.status}`,
    );
    const saturatedB = await http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "admission two", clientMessageId: `admission-b-${pid}` }),
      },
      cookieB,
    );
    check(
      saturatedA.response.status === 202 && saturatedB.response.status === 202,
      "could not fill global admission",
    );
    const saturatedC = await http(
      "/api/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "admission three", clientMessageId: `admission-c-${pid}` }),
      },
      cookieC,
    );
    check(
      saturatedC.response.status === 429,
      `global admission returned ${saturatedC.response.status}`,
    );
    await waitSnapshot(
      cookieA,
      resultSchema.parse(saturatedA.body).threadId,
      (item) => item.runs[0]?.status === "completed",
      60_000,
    );
    await waitSnapshot(
      cookieB,
      resultSchema.parse(saturatedB.body).threadId,
      (item) => item.runs[0]?.status === "completed",
      60_000,
    );
  }

  const followup = await http(
    `/api/threads/${result.threadId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "followup script", clientMessageId: `followup-${pid}` }),
    },
    cookieA,
  );
  check(
    followup.response.status === 202,
    `follow-up submit failed: ${followup.response.status} ${followup.text}`,
  );
  const followupSnapshot = await waitSnapshot(
    cookieA,
    result.threadId,
    (item) => item.runs.length === 2 && item.runs[1]?.status === "completed",
  );
  check(
    followupSnapshot.workspace?.dockerName === snapshot.workspace?.dockerName,
    "follow-up did not reuse workspace",
  );
  {
    const workspaceName = `cloud-swe-${result.threadId}`;
    await Bun.sleep(2500);
    const paused = await command("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}",
      workspaceName,
    ]);
    check(
      paused.code === 0 && paused.stdout.trim() === "paused",
      `workspace was not paused: ${paused.stdout}`,
    );
    await Bun.sleep(4500);
    const deleted = await command("docker", ["inspect", workspaceName]);
    check(deleted.code !== 0, "idle cleanup did not delete workspace");
    const recreated = await http(
      `/api/threads/${result.threadId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "recreate workspace", clientMessageId: `recreate-${pid}` }),
      },
      cookieA,
    );
    check(recreated.response.status === 202, "recreation follow-up failed");
    await waitSnapshot(
      cookieA,
      result.threadId,
      (item) => item.runs.length === 3 && item.runs[2]?.status === "completed",
      60_000,
    );
    const recreatedInspect = await command("docker", ["inspect", workspaceName]);
    check(recreatedInspect.code === 0, "workspace was not recreated");
  }

  const temporalStopped = await command("docker", ["compose", "stop", "temporal"]);
  check(temporalStopped.code === 0, `could not stop Temporal: ${temporalStopped.stderr}`);
  const temporalDownRun = await http(
    "/api/threads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "accepted while Temporal is down",
        clientMessageId: `temporal-down-${pid}`,
      }),
    },
    cookieB,
  );
  check(
    temporalDownRun.response.status === 202,
    "request was not accepted while Temporal was down",
  );
  const temporalRun = resultSchema.parse(temporalDownRun.body);
  const temporalStarted = await command("docker", ["compose", "up", "-d", "--wait", "temporal"]);
  check(temporalStarted.code === 0, `could not restart Temporal: ${temporalStarted.stderr}`);
  await waitSnapshot(
    cookieB,
    temporalRun.threadId,
    (item) => item.runs[0]?.status === "completed",
    60_000,
  );

  const postgresRestart = await command("docker", ["compose", "restart", "postgres"]);
  check(postgresRestart.code === 0, `could not restart PostgreSQL: ${postgresRestart.stderr}`);
  const postgresReady = await command("docker", ["compose", "up", "-d", "--wait", "postgres"]);
  check(postgresReady.code === 0, `PostgreSQL did not become ready: ${postgresReady.stderr}`);
  const postgresRun = await http(
    "/api/threads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "after PostgreSQL restart",
        clientMessageId: `postgres-restart-${pid}`,
      }),
    },
    cookieA,
  );
  check(postgresRun.response.status === 202, "request after PostgreSQL restart was not accepted");
  const postgresRunResult = resultSchema.parse(postgresRun.body);
  await waitSnapshot(
    cookieA,
    postgresRunResult.threadId,
    (item) => item.runs[0]?.status === "completed",
    60_000,
  );

  const inspect = await command("docker", ["inspect", `cloud-swe-${postgresRunResult.threadId}`]);
  check(inspect.code === 0, "sandbox container was not created");
  const [sandboxInspect] = z
    .array(
      z.object({
        HostConfig: z.object({
          Binds: z.array(z.string()).nullable(),
          NetworkMode: z.string(),
          CapDrop: z.array(z.string()).nullable(),
          SecurityOpt: z.array(z.string()).nullable(),
          Privileged: z.boolean(),
        }),
        Mounts: z.array(z.unknown()),
      }),
    )
    .parse(JSON.parse(inspect.stdout));
  check(sandboxInspect, "Docker inspect was empty");
  const hostConfig = sandboxInspect.HostConfig;
  check(
    !hostConfig.Privileged && sandboxInspect.Mounts.length === 0,
    "sandbox has privilege or mounts",
  );
  check(
    !hostConfig.Binds?.some((bind) => bind.includes("docker.sock") || bind.includes("/workspace")),
    "sandbox exposed forbidden mount",
  );
  check(
    !inspect.stdout.includes(secret) && !inspect.stdout.includes(databaseUrl),
    "sandbox received server credentials",
  );
  check(hostConfig.NetworkMode === "none", `sandbox network was ${hostConfig.NetworkMode}`);
  check(hostConfig.CapDrop?.includes("ALL"), "sandbox did not drop all capabilities");
  check(
    hostConfig.SecurityOpt?.includes("no-new-privileges"),
    "sandbox allows privilege escalation",
  );
  containers.add(`cloud-swe-${postgresRunResult.threadId}`);
  await stop(dispatcher);
  dispatcher = start("node", ["--import", tsxLoader, "apps/runner/src/index.ts", "dispatcher"], {
    TEMPORAL_TASK_QUEUE: `e2e-${pid}`,
    RUNNER_MAX_RUN_MS: "1500",
    RUNNER_STEP_DELAY_MS: "1000",
  });
  const timeoutRequest = await http(
    "/api/threads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "exercise the run time limit",
        clientMessageId: `timeout-${pid}`,
      }),
    },
    cookieB,
  );
  check(timeoutRequest.response.status === 202, "timeout run was not accepted");
  const timeoutRun = resultSchema.parse(timeoutRequest.body);
  const timedOut = await waitSnapshot(
    cookieB,
    timeoutRun.threadId,
    (item) => item.runs[0]?.status === "failed",
    30000,
  );
  check(
    timedOut.messages.every((message) => message.role !== "assistant"),
    "timed-out run persisted a successful response",
  );
  const failureEvents = await readSse(
    cookieB,
    timeoutRun.threadId,
    undefined,
    new Set(["run.failed"]),
  );
  check(
    failureEvents.filter((event) => event.type === "run.failed").length === 1,
    "timeout did not produce one durable failure",
  );
  console.log(`BACKEND_E2E_PASS db=${dbName} thread=${result.threadId}`);
}

async function cleanup() {
  await Promise.all(children.map((child) => stop(child)));
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

try {
  await main();
} catch (error) {
  for (const [child, tail] of outputTails)
    process.stderr.write(`Process ${child.pid} last output:\n${tail}\n`);
  throw error;
} finally {
  await cleanup();
}
