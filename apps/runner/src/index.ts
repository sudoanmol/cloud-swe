import { env } from "@cloud-swe/env/runner";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Effect } from "effect";
import pino from "pino";
import { createActivities } from "./activities.js";
import { createActivityRuntime } from "./activity-scope.js";
import { createExecutionCoordinator } from "./execution-coordinator.js";
import { createDockerProvider } from "./docker.js";
import { createDemoCompute } from "@cloud-swe/db/demo-compute";
import { createFreestyleProvider } from "./freestyle.js";
import { createRunnerDatabase } from "./db.js";
import { runDispatcher } from "./dispatcher.js";
import { loadRunnerConfig } from "./config.js";
import type { SandboxProviders } from "./sandbox.js";
import { attachmentStorageConfig } from "@cloud-swe/env/attachments";
import { createAttachmentObjectStore } from "@cloud-swe/db/attachment-objects";

const logger = pino({
  name: "cloud-swe-runner",
  level: env.LOG_LEVEL,
  redact: [
    "authorization",
    "cookie",
    "password",
    "token",
    "apiKey",
    "headers.authorization",
    "headers.cookie",
  ],
});

const TEMPORAL_CONNECT_TIMEOUT_MS = 5_000;

const RESOURCE_CLEANUP_TIMEOUT_MS = 10_000;

const release = (close: () => Promise<void>, resource: string) =>
  Effect.timeoutOrElse(Effect.promise(close), {
    duration: RESOURCE_CLEANUP_TIMEOUT_MS,
    orElse: () =>
      Effect.sync(() => {
        logger.warn({ resource }, "Runner resource cleanup timed out");
      }),
  }).pipe(
    Effect.catchCause(() =>
      Effect.sync(() => {
        logger.warn({ resource }, "Runner resource cleanup failed");
      }),
    ),
  );

const connectTemporal = () =>
  Effect.callback<NativeConnection, Error>((resume, signal) => {
    if (signal.aborted) return;

    void NativeConnection.connect({ address: env.TEMPORAL_ADDRESS }).then(
      (connection) => {
        if (signal.aborted) {
          void connection.close().catch(() => {
            logger.warn({ resource: "temporal" }, "Late Temporal connection cleanup failed");
          });
        } else {
          resume(Effect.succeed(connection));
        }
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection crosses the SDK boundary and is normalized below.
      (error: unknown) => {
        if (!signal.aborted) {
          resume(
            Effect.fail(error instanceof Error ? error : new Error("Temporal connection failed")),
          );
        }
      },
    );
  });

// Temporal 1.23 creates workflow threads before its native worker. If native
// initialization fails, the SDK does not destroy those threads. Capture that
// resource through its protected factory until Worker takes ownership.
async function createWorker(options: Parameters<typeof Worker.create>[0]): Promise<Worker> {
  let disposeWorkflows: (() => Promise<void>) | undefined;

  class InitializingWorker extends Worker {
    protected static override async createWorkflowCreator(
      ...args: Parameters<typeof Worker.createWorkflowCreator>
    ) {
      const creator = await super.createWorkflowCreator(...args);
      disposeWorkflows = () => creator.destroy();

      return creator;
    }
  }

  try {
    return await InitializingWorker.create(options);
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the SDK initialization error after cleanup.
  } catch (error) {
    try {
      await disposeWorkflows?.();
    } catch {
      logger.warn("Workflow thread cleanup failed during worker initialization");
    }

    throw error;
  }
}

export async function runWorkerUntilStopped(
  worker: Pick<Worker, "run" | "shutdown">,
  signal: AbortSignal,
): Promise<void> {
  let shutdownRequested = false;

  const shutdown = () => {
    if (shutdownRequested) return;

    shutdownRequested = true;
    worker.shutdown();
  };

  try {
    const running = worker.run();
    signal.addEventListener("abort", shutdown, { once: true });

    if (signal.aborted) shutdown();
    await running;
  } finally {
    signal.removeEventListener("abort", shutdown);
  }
}

async function main(): Promise<void> {
  const config = loadRunnerConfig();
  const attachmentConfig = attachmentStorageConfig();

  const attachmentObjects = attachmentConfig
    ? createAttachmentObjectStore(attachmentConfig)
    : undefined;

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
        }),
      );

      const database = yield* Effect.acquireRelease(Effect.sync(createRunnerDatabase), (db) =>
        release(db.close, "database"),
      );

      if (process.argv[2] === "dispatcher") {
        return yield* Effect.promise(() =>
          runDispatcher(database.store, logger, config, controller.signal),
        );
      }

      const sandboxes: SandboxProviders = {
        docker: createDockerProvider(config, logger),
        freestyle: config.freestyleApiKey
          ? createFreestyleProvider(config, logger, {
              compute: createDemoCompute(database.pool, config.demoMonthlyVmSeconds),
              isOwner: database.store.threadIsOwner,
            })
          : undefined,
      };

      const coordinator = createExecutionCoordinator({
        providers: sandboxes,
        store: database.store,
        config,
        logger,
      });

      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createActivityRuntime({ store: database.store, pool: database.pool, coordinator }),
        ),
        (owned) => owned.disposeEffect,
      );

      const connection = yield* Effect.acquireRelease(
        connectTemporal().pipe(
          Effect.timeoutOrElse({
            duration: TEMPORAL_CONNECT_TIMEOUT_MS,
            orElse: () => Effect.fail(new Error("Temporal connection timed out")),
          }),
        ),
        (owned) => release(() => owned.close(), "temporal"),
      );

      const worker = yield* Effect.promise(() =>
        createWorker({
          workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
          activities: createActivities(runtime, sandboxes, logger, config, attachmentObjects),
          taskQueue: env.TEMPORAL_TASK_QUEUE,
          namespace: env.TEMPORAL_NAMESPACE,
          connection,
          maxConcurrentActivityTaskExecutions: env.RUNNER_ACTIVITY_CONCURRENCY,
        }),
      );

      logger.info({ taskQueue: env.TEMPORAL_TASK_QUEUE }, "Temporal worker started");
      // Keep this promise owned by the scope. It settles only after activities stop,
      // so the Temporal connection and database outlive the worker's shutdown.
      yield* Effect.promise(() => runWorkerUntilStopped(worker, controller.signal));
    }),
  );

  await Effect.runPromise(program);
}

if (import.meta.main) {
  main().catch(() => {
    logger.fatal("Runner stopped after an internal failure");
    process.exitCode = 1;
  });
}
