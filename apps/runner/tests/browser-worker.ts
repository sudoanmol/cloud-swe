import { NativeConnection, Worker } from "@temporalio/worker";
import pino from "pino";
import { createActivities } from "../src/activities.js";
import { createActivityRuntime } from "../src/activity-scope.js";
import { loadRunnerConfig, type RunnerConfig } from "../src/config.js";
import { createRunnerDatabase } from "../src/db.js";
import { createDockerProvider } from "../src/docker.js";
import { createExecutionCoordinator } from "../src/execution-coordinator.js";
import { runWorkerUntilStopped } from "../src/index.js";
import type { SandboxProvider, WorkspaceRef } from "../src/sandbox.js";

// Test-only provider fixture: production rightly rejects repository-backed Docker
// workspaces. Supply the Modal contract with offline Docker commands here,
// without weakening that guard or contacting a paid provider.
const config: RunnerConfig = { ...loadRunnerConfig(), sandboxProvider: "modal" };

const logger = pino({ name: "browser-worker-fixture", level: "warn" });

const database = createRunnerDatabase();

const docker = createDockerProvider(config, logger);

const dockerWorkspace = (workspace: WorkspaceRef): WorkspaceRef => ({
  ...workspace,
  provider: "docker",
});

const fixture: SandboxProvider = {
  async resolve(workspace, signal) {
    const resolved = await docker.resolve(dockerWorkspace(workspace), signal);

    return { ...resolved, workspace: { ...resolved.workspace, provider: "modal" } };
  },
  ensure: (workspace, signal) => docker.ensure(dockerWorkspace(workspace), signal),
  exec: (workspace, request, signal) => docker.exec(dockerWorkspace(workspace), request, signal),
  pause: (workspace, signal) => docker.pause(dockerWorkspace(workspace), signal),
  delete: (workspace, signal) => docker.delete(dockerWorkspace(workspace), signal),
};

const sandboxes = { modal: fixture };

const coordinator = createExecutionCoordinator({
  providers: sandboxes,
  store: database.store,
  config,
  logger,
});

const runtime = createActivityRuntime({ store: database.store, pool: database.pool, coordinator });

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS });

const controller = new AbortController();

const stop = () => controller.abort();

process.once("SIGTERM", stop);

process.once("SIGINT", stop);

try {
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "e2e-web",
    workflowsPath: new URL("../src/workflows.ts", import.meta.url).pathname,
    activities: createActivities(runtime, sandboxes, logger, config),
  });

  await runWorkerUntilStopped(worker, controller.signal);
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await runtime.dispose();
  await connection.close();
  await database.close();
}
