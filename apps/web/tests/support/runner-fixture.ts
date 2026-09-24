/**
 * Browser-suite runner fixture: starts the real dispatcher and worker so a
 * submitted run is actually admitted and executed, exactly as the local
 * integration harness does, and exposes an HTTP readiness probe because neither
 * process serves HTTP on its own.
 *
 * Started by `apps/web/playwright.config.ts` when `E2E_WITH_RUNNER=1`. Every
 * connection value comes from the environment, so the isolated Compose
 * project/ports are the caller's choice.
 */
const root = new URL("../../../../", import.meta.url).pathname;

const tsxLoader = "./apps/runner/node_modules/tsx/dist/loader.mjs";

const port = Number(process.env.E2E_RUNNER_PORT ?? 3311);

const taskQueue = process.env.E2E_TASK_QUEUE ?? "e2e-web";

const children = [start("worker"), start("dispatcher")];

function start(role: "worker" | "dispatcher") {
  const script =
    role === "worker" ? "apps/runner/tests/browser-worker.ts" : "apps/runner/src/index.ts";

  const child = Bun.spawn(["node", "--import", tsxLoader, script, role], {
    cwd: root,
    env: { ...process.env, TEMPORAL_TASK_QUEUE: taskQueue },
    stderr: "inherit",
    stdout: "inherit",
  });

  child.exited.then((code) => {
    process.stderr.write(`runner ${role} exited with ${code}\n`);
    process.exit(code === 0 ? 1 : code);
  });

  return child;
}

/** Both processes are spawned; the worker registers its poller asynchronously. */
const startedAt = Date.now();

const settleMs = Number(process.env.E2E_RUNNER_SETTLE_MS ?? 3_000);

Bun.serve({
  fetch() {
    if (Date.now() - startedAt < settleMs) return new Response("starting", { status: 503 });

    return new Response("ok");
  },
  hostname: "127.0.0.1",
  port,
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(0);
  });
