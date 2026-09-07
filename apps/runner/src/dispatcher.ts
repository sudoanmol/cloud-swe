import { Client, Connection } from "@temporalio/client";
import type { Logger } from "pino";
import type { ThreadStore } from "@cloud-swe/db/thread-contracts";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerConfig } from "./config.js";

const backoff = (attempt: number) => Math.min(60_000, 500 * 2 ** Math.min(attempt, 7));
export async function runDispatcher(
  store: ThreadStore,
  logger: Logger,
  config: RunnerConfig,
  signal: AbortSignal,
): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "cloud-swe-runner";
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
      logger.warn({ err: error }, "Temporal unavailable; retrying connection");
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
                args: [record.threadId, config],
                signal: record.type === "run.cancel" ? "cancelRun" : "startRun",
                signalArgs: [record.runId],
              }),
            );
            await store.markDelivered(record.id);
          } catch (error) {
            logger.warn({ outboxId: record.id, err: error }, "Outbox delivery will retry");
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
        logger.warn({ err: error }, "Outbox polling unavailable; retrying");
        await wait(1_000);
      }
    }
  } finally {
    await connection.close();
  }
}
