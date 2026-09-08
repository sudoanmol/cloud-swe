import { env } from "@cloud-swe/env/runner";
import pino from "pino";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities } from "./activities.js";
import { createDockerProvider } from "./docker.js";
import { createRunnerDatabase } from "./db.js";
import { runDispatcher } from "./dispatcher.js";
import { loadRunnerConfig } from "./config.js";

const logger = pino({ name: "cloud-swe-runner", level: env.LOG_LEVEL });
const taskQueue = env.TEMPORAL_TASK_QUEUE;

async function runWorker(signal: AbortSignal): Promise<void> {
  const database = createRunnerDatabase();
  const sandbox = createDockerProvider(logger);
  const activities = createActivities(database.store, sandbox, logger, database.pool);
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
  } else await runWorker(controller.signal);
}

main().catch((error: unknown) => {
  logger.fatal({ err: error instanceof Error ? error.message : "unknown error" }, "runner stopped");
  process.exitCode = 1;
});
