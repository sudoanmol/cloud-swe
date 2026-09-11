import { env } from "@cloud-swe/env/runner";
import pino from "pino";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities } from "./activities.js";
import { createExecutionCoordinator } from "./execution-coordinator.js";
import { createDockerProvider } from "./docker.js";
import { createFreestyleProvider } from "./freestyle.js";
import { createRunnerDatabase } from "./db.js";
import { runDispatcher } from "./dispatcher.js";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import type { SandboxProviders } from "./sandbox.js";

const logger = pino({ name: "cloud-swe-runner", level: env.LOG_LEVEL });

const taskQueue = env.TEMPORAL_TASK_QUEUE;

async function runWorker(signal: AbortSignal, config: RunnerConfig): Promise<void> {
  const database = createRunnerDatabase();

  const sandboxes: SandboxProviders = {
    docker: createDockerProvider(config, logger),
    freestyle: config.freestyleApiKey ? createFreestyleProvider(config, logger) : undefined,
  };

  const coordinator = createExecutionCoordinator({
    providers: sandboxes,
    store: database.store,
    config,
    logger,
  });

  const activities = createActivities(
    database.store,
    sandboxes,
    logger,
    database.pool,
    config,
    coordinator,
  );

  const connection = await NativeConnection.connect({
    address: env.TEMPORAL_ADDRESS,
  });

  const worker = await Worker.create({
    workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
    activities,
    taskQueue,
    namespace: env.TEMPORAL_NAMESPACE,
    connection,
    maxConcurrentActivityTaskExecutions: env.RUNNER_ACTIVITY_CONCURRENCY,
  });

  const stop = () => void worker.shutdown();
  signal.addEventListener("abort", stop, { once: true });
  logger.info({ taskQueue }, "temporal worker started");

  try {
    await worker.run();
  } finally {
    signal.removeEventListener("abort", stop);
    await connection.close();
    await database.close();
  }
}

async function main(): Promise<void> {
  const config = loadRunnerConfig();
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  if (process.argv[2] === "dispatcher") {
    const database = createRunnerDatabase();

    try {
      await runDispatcher(database.store, logger, config, controller.signal);
    } finally {
      await database.close();
    }
  } else await runWorker(controller.signal, config);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The process entry point is the final boundary for uncaught failures.
main().catch((error: unknown) => {
  logger.fatal({ err: error instanceof Error ? error.message : "unknown error" }, "runner stopped");
  process.exitCode = 1;
});
