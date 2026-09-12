import { publicFailure } from "@cloud-swe/db/public-failure";
import { env } from "@cloud-swe/env/runner";
import { Client, Connection } from "@temporalio/client";
import type { Logger } from "pino";
import type { ThreadStore } from "@cloud-swe/db/thread-contracts";
import { setTimeout as delay } from "node:timers/promises";
import { toWorkflowConfig, type RunnerConfig } from "./config.js";

const backoff = (attempt: number) => Math.min(60_000, 500 * 2 ** Math.min(attempt, 7));

export async function runDispatcher(
  store: ThreadStore,
  logger: Logger,
  config: RunnerConfig,
  signal: AbortSignal,
): Promise<void> {
  const address = env.TEMPORAL_ADDRESS;
  const namespace = env.TEMPORAL_NAMESPACE;
  const taskQueue = env.TEMPORAL_TASK_QUEUE;

  const wait = async (ms: number) => {
    try {
      await delay(ms, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  };

  let connection: Connection | undefined;

  while (!signal.aborted && !connection) {
    try {
      connection = await Connection.connect({ address, connectTimeout: 5_000 });
    } catch (error) {
      logger.warn(
        { errorCode: publicFailure(error).code },
        "Temporal unavailable; retrying connection",
      );
      await wait(1_000);
    }
  }

  if (!connection) return;
  const client = new Client({ connection, namespace });
  logger.info({ taskQueue }, "Outbox dispatcher started");

  try {
    while (!signal.aborted) {
      try {
        const records = await store.listPendingOutbox(50);

        for (const record of records) {
          if (signal.aborted) break;

          try {
            await connection.withDeadline(Date.now() + 5_000, () =>
              client.workflow.signalWithStart("threadWorkflow", {
                workflowId: `thread:${record.threadId}`,
                taskQueue,
                args: [record.threadId, toWorkflowConfig(config)],
                signal:
                  record.type === "run.cancel"
                    ? "cancelRun"
                    : record.type === "git.decision"
                      ? "gitDecision"
                      : "startRun",
                signalArgs: [record.runId],
              }),
            );
            await store.markDelivered(record.id);
          } catch (error) {
            logger.warn(
              { outboxId: record.id, errorCode: publicFailure(error).code },
              "Outbox delivery will retry",
            );
            await store.recordFailure(
              record.id,
              "Temporal delivery failed",
              new Date(Date.now() + backoff(record.attempts)),
            );
          }
        }

        await wait(500);
      } catch (error) {
        // A database outage must not permanently stop delivery of accepted requests.
        logger.warn(
          { errorCode: publicFailure(error).code },
          "Outbox polling unavailable; retrying",
        );
        await wait(1_000);
      }
    }
  } finally {
    await connection.close();
  }
}
