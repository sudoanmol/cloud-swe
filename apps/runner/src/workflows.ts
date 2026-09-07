import {
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { createActivities } from "./activities.js";
import type { RunnerConfig } from "./config.js";

type Activities = ReturnType<typeof createActivities>;
export const startRun = defineSignal<[string]>("startRun");
export const cancelRun = defineSignal<[string]>("cancelRun");
type Input = RunnerConfig & { pending?: string[] };

export async function threadWorkflow(threadId: string, config: Input): Promise<void> {
  const { executeRun } = proxyActivities<Activities>({
    startToCloseTimeout: config.maxRunMs,
    scheduleToCloseTimeout: config.maxRunMs,
    heartbeatTimeout: "5 seconds",
    retry: { initialInterval: "1 second", maximumInterval: "5 seconds", maximumAttempts: 5 },
    cancellationType: "WAIT_CANCELLATION_COMPLETED",
  });
  const { finalizeRun, pauseWorkspace, deleteWorkspace } = proxyActivities<Activities>({
    startToCloseTimeout: "60 seconds",
    heartbeatTimeout: "5 seconds",
    retry: { initialInterval: "1 second", maximumInterval: "30 seconds" },
    cancellationType: "WAIT_CANCELLATION_COMPLETED",
  });
  const pending = [...(config.pending ?? [])];
  let activeRunId: string | undefined;
  let activeScope: CancellationScope | undefined;
  let runCount = 0;
  setHandler(startRun, (runId) => {
    if (!pending.includes(runId) && runId !== activeRunId) pending.push(runId);
  });
  setHandler(cancelRun, (runId) => {
    // The API already persisted the flag, including cancellations received before execution.
    if (runId === activeRunId) activeScope?.cancel();
  });

  for (;;) {
    if (runCount >= 100 || workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof threadWorkflow>(threadId, { ...config, pending });
    }
    const runId = pending.shift();
    if (runId !== undefined) {
      activeRunId = runId;
      try {
        await CancellationScope.cancellable(async () => {
          activeScope = CancellationScope.current();
          await executeRun(runId, { stepDelayMs: config.stepDelayMs, maxRunMs: config.maxRunMs });
        });
      } catch (error) {
        await CancellationScope.nonCancellable(() =>
          finalizeRun(
            runId,
            isCancellation(error) ? "cancelled" : "failed",
            isCancellation(error)
              ? undefined
              : "Scripted execution failed or exceeded its time limit",
          ),
        );
      } finally {
        activeScope = undefined;
        activeRunId = undefined;
      }
      runCount += 1;
      continue;
    }
    if (await condition(() => pending.length > 0, config.idlePauseMs)) continue;
    await pauseWorkspace(threadId);
    if (await condition(() => pending.length > 0, config.cleanupMs)) continue;
    await deleteWorkspace(threadId);
    // A deleted computer can be recreated for the same durable thread on its next message.
    await condition(() => pending.length > 0);
  }
}
