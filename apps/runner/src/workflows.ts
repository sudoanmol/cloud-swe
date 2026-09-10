import {
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  proxyActivities,
  rootCause,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { createActivities, LifecycleResult } from "./activities.js";
import type { RunnerWorkflowConfig } from "./config.js";

type Activities = ReturnType<typeof createActivities>;
type Input = RunnerWorkflowConfig & { pending?: string[] };
type WorkflowInput = Partial<RunnerWorkflowConfig> & { pending?: string[] };

export const startRun = defineSignal<[string]>("startRun");
export const cancelRun = defineSignal<[string]>("cancelRun");

const nonRetryableActivityErrors = [
  "INVALID_CONFIGURATION",
  "RUN_TERMINAL",
  "RUN_TIMEOUT",
  "WORKSPACE_REPREPARE",
  "WORKSPACE_GENERATION_MISMATCH",
  "REPOSITORY_INITIALIZATION",
  "REPOSITORY_PROVIDER_UNSUPPORTED",
  "INVALID_STORED_REPOSITORY",
  "WORKSPACE_UNSUPPORTED_PROVIDER",
  "CHECKPOINT_TOO_LARGE",
];

const defaultWorkflowConfig: RunnerWorkflowConfig = {
  idlePauseMs: 30_000,
  cleanupMs: 300_000,
  maxRunMs: 900_000,
  workspacePreparationTimeoutMs: 420_000,
  providerTimeoutMs: 30_000,
  commandReconcileTimeoutMs: 30_000,
  activityRetryMaxAttempts: 3,
  activityRetryWindowMs: 1_500_000,
};

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * New dispatcher calls always carry the complete RunnerWorkflowConfig. The
 * defaults make malformed/manual starts fail safe while the documented
 * upgrade policy drains old open executions before deploying this workflow
 * sequence; this is not a replay-compatibility claim.
 */
export function normalizeWorkflowConfig(input: WorkflowInput): Input {
  return {
    idlePauseMs: numberOr(input.idlePauseMs, defaultWorkflowConfig.idlePauseMs),
    cleanupMs: numberOr(input.cleanupMs, defaultWorkflowConfig.cleanupMs),
    maxRunMs: numberOr(input.maxRunMs, defaultWorkflowConfig.maxRunMs),
    workspacePreparationTimeoutMs: numberOr(
      input.workspacePreparationTimeoutMs,
      defaultWorkflowConfig.workspacePreparationTimeoutMs,
    ),
    providerTimeoutMs: numberOr(input.providerTimeoutMs, defaultWorkflowConfig.providerTimeoutMs),
    commandReconcileTimeoutMs: numberOr(
      input.commandReconcileTimeoutMs,
      defaultWorkflowConfig.commandReconcileTimeoutMs,
    ),
    activityRetryMaxAttempts: Math.max(
      1,
      Math.floor(
        numberOr(input.activityRetryMaxAttempts, defaultWorkflowConfig.activityRetryMaxAttempts),
      ),
    ),
    activityRetryWindowMs: numberOr(
      input.activityRetryWindowMs,
      defaultWorkflowConfig.activityRetryWindowMs,
    ),
    pending: input.pending ? [...input.pending] : [],
  };
}

function retryPolicy(config: RunnerWorkflowConfig) {
  return {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    maximumAttempts: config.activityRetryMaxAttempts,
    nonRetryableErrorTypes: [...nonRetryableActivityErrors],
  };
}

function publicFailureMessage(message: string): string {
  return message
    .replace(
      /(authorization|cookie|token|secret|api[-_]?key|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/(?:\/Users\/|\/home\/|\/var\/|\/tmp\/)[^\s'"`]+/g, "[worker-path]")
    .slice(0, 500);
}

export function runFailureMessage(error: unknown): string | undefined {
  if (isCancellation(error)) return undefined;
  const type = failureType(error);
  if (type === "RUN_TIMEOUT") return "Run exceeded its active execution time limit";
  if (type === "RUN_TERMINAL") return "Run is no longer active";
  if (type === "WORKSPACE_REPREPARE" || type === "WORKSPACE_GENERATION_MISMATCH")
    return "The workspace was replaced and must be prepared before execution can continue";
  if (type === "CHECKPOINT_TOO_LARGE")
    return "The agent session checkpoint exceeded its storage limit";
  if (type === "INVALID_CONFIGURATION") return "The runner configuration is invalid";
  if (error instanceof Error) {
    const message = rootCause(error);
    if (message) return publicFailureMessage(message);
  }
  return "Agent execution failed or exceeded its time limit";
}

function isDeferred(result: LifecycleResult): boolean {
  return result.outcome === "deferred";
}

function failureType(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const type = Reflect.get(error, "type");
  if (typeof type === "string") return type;
  // ThreadStoreError carries `code` (e.g. WORKSPACE_GENERATION_MISMATCH).
  // Temporal serializes custom fields, so check both for recovery routing.
  const code = Reflect.get(error, "code");
  if (typeof code === "string") return code;
  const cause = Reflect.get(error, "cause");
  return cause === error ? undefined : failureType(cause);
}

function needsWorkspacePreparation(error: unknown): boolean {
  const type = failureType(error);
  return type === "WORKSPACE_REPREPARE" || type === "WORKSPACE_GENERATION_MISMATCH";
}

/**
 * Workflow histories are upgraded with the documented non-rolling drain:
 * finish/cancel runs, reconcile commands and lifecycle transitions, close idle
 * old workflows, then deploy this sequence. New messages signalWithStart the
 * stable workflow ID again, creating a new execution after a closed workflow.
 */
export async function threadWorkflow(threadId: string, rawConfig: WorkflowInput): Promise<void> {
  const config = normalizeWorkflowConfig(rawConfig);
  const preparation = proxyActivities<Activities>({
    startToCloseTimeout: config.workspacePreparationTimeoutMs,
    scheduleToCloseTimeout: config.activityRetryWindowMs,
    heartbeatTimeout: "5 seconds",
    retry: retryPolicy(config),
    cancellationType: "WAIT_CANCELLATION_COMPLETED",
  });
  const execution = proxyActivities<Activities>({
    startToCloseTimeout: config.maxRunMs,
    scheduleToCloseTimeout: config.activityRetryWindowMs,
    heartbeatTimeout: "5 seconds",
    retry: retryPolicy(config),
    cancellationType: "WAIT_CANCELLATION_COMPLETED",
  });
  const lifecycle = proxyActivities<Activities>({
    startToCloseTimeout: config.providerTimeoutMs + config.commandReconcileTimeoutMs,
    scheduleToCloseTimeout: config.activityRetryWindowMs,
    heartbeatTimeout: "5 seconds",
    retry: retryPolicy(config),
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
          const prepared = await preparation.prepareWorkspace(runId);
          if (prepared.kind === "prepared") await execution.runExecution(runId);
        });
      } catch (error) {
        if (!isCancellation(error) && needsWorkspacePreparation(error)) {
          try {
            const prepared = await preparation.prepareWorkspace(runId);
            if (prepared.kind === "prepared") await execution.runExecution(runId);
            else if (prepared.kind === "cancelled")
              throw new Error("Run was cancelled during workspace recovery");
          } catch (recoveryError) {
            const failureMessage = runFailureMessage(recoveryError);
            await CancellationScope.nonCancellable(() =>
              lifecycle.finalizeRun(
                runId,
                isCancellation(recoveryError) ? "cancelled" : "failed",
                failureMessage,
              ),
            );
          }
        } else {
          const failureMessage = runFailureMessage(error);
          await CancellationScope.nonCancellable(() =>
            lifecycle.finalizeRun(
              runId,
              isCancellation(error) ? "cancelled" : "failed",
              failureMessage,
            ),
          );
        }
      } finally {
        activeScope = undefined;
        activeRunId = undefined;
      }
      runCount += 1;
      continue;
    }

    if (await condition(() => pending.length > 0, config.idlePauseMs)) continue;
    const paused = await lifecycle.pauseWorkspace(threadId);
    if (isDeferred(paused)) {
      await condition(() => pending.length > 0, config.cleanupMs);
      continue;
    }

    if (await condition(() => pending.length > 0, config.cleanupMs)) continue;
    const deleted = await lifecycle.deleteWorkspace(threadId);
    if (isDeferred(deleted)) {
      await condition(() => pending.length > 0, config.cleanupMs);
      continue;
    }

    await condition(() => pending.length > 0);
  }
}
