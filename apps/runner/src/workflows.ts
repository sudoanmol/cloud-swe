import { failureIdentities } from "./failure.js";
import {
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { createActivities, LifecycleResult } from "./activities.js";
import type { RunnerWorkflowConfig } from "./config.js";
import { publicFailureForCode } from "@cloud-swe/db/public-failure";

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
  "WORKSPACE_QUARANTINED",
  "CHECKPOINT_TOO_LARGE",
  "CHECKPOINT_OWNERSHIP_LOST",
  "INVALID_CHECKPOINT",
];

const defaultWorkflowConfig: RunnerWorkflowConfig = {
  idlePauseMs: 30_000,
  cleanupMs: 3_600_000,
  maxRunMs: 120_000,
  workspacePreparationTimeoutMs: 420_000,
  providerTimeoutMs: 30_000,
  commandReconcileTimeoutMs: 30_000,
  activityRetryMaxAttempts: 3,
  activityRetryWindowMs: 1_500_000,
};

/**
 * Sequential lifecycle stages: external identity resolve, command
 * reconciliation, then pause/delete. Provider operations share one total
 * providerTimeout across nested calls, plus DB/lock grace.
 */
export function lifecycleStartToCloseMs(config: RunnerWorkflowConfig): number {
  return config.providerTimeoutMs * 2 + config.commandReconcileTimeoutMs + 30_000;
}

function numberOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Temporal failure identities are decoded before public mapping.
export function runFailureMessage(error: unknown): string | undefined {
  if (isCancellation(error)) return undefined;

  return publicFailureForCode(failureType(error) ?? "ACTIVITY_FAILED").message;
}

function isDeferred(result: LifecycleResult): boolean {
  return result.outcome === "deferred";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decode arbitrary Temporal failures before choosing a recovery action.
function failureType(error: unknown): string | undefined {
  for (const identity of failureIdentities(error)) {
    const type = identity.type ?? identity.code;

    if (type !== undefined) return type;
  }

  return undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Decode a caught activity rejection before routing recovery.
function needsWorkspacePreparation(error: unknown): boolean {
  const type = failureType(error);

  return type === "WORKSPACE_REPREPARE" || type === "WORKSPACE_GENERATION_MISMATCH";
}

async function finalizeRunDurably(
  lifecycle: Activities,
  runId: string,
  status: "failed" | "cancelled",
  failureMessage: string | undefined,
): Promise<void> {
  let waitMs = 1_000;

  for (;;) {
    try {
      await CancellationScope.nonCancellable(() =>
        lifecycle.finalizeRun(runId, status, failureMessage),
      );

      return;
    } catch (finalizeError) {
      log.warn("Run finalizer failed; retrying with a durable timer", {
        runId,
        error: publicFailureForCode(failureType(finalizeError) ?? "ACTIVITY_FAILED").code,
      });
      await CancellationScope.nonCancellable(() => condition(() => false, waitMs));
      waitMs = Math.min(waitMs * 2, 60_000);
    }
  }
}

async function prepareAndExecute(preparation: Activities, execution: Activities, runId: string) {
  const prepared = await preparation.prepareWorkspace(runId);

  if (prepared.kind === "prepared") await execution.runExecution(runId);

  return prepared;
}

async function recoverOrFinalize(
  preparation: Activities,
  execution: Activities,
  lifecycle: Activities,
  runId: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recovery receives an activity rejection and maps only its identity.
  error: unknown,
) {
  if (failureType(error) === "CHECKPOINT_OWNERSHIP_LOST") return;

  if (!isCancellation(error) && needsWorkspacePreparation(error)) {
    try {
      const prepared = await prepareAndExecute(preparation, execution, runId);

      if (prepared.kind === "cancelled")
        throw new Error("Run was cancelled during workspace recovery");

      return;
    } catch (recoveryError) {
      if (failureType(recoveryError) === "CHECKPOINT_OWNERSHIP_LOST") return;

      await finalizeRunDurably(
        lifecycle,
        runId,
        isCancellation(recoveryError) ? "cancelled" : "failed",
        runFailureMessage(recoveryError),
      );

      return;
    }
  }

  await finalizeRunDurably(
    lifecycle,
    runId,
    isCancellation(error) ? "cancelled" : "failed",
    runFailureMessage(error),
  );
}

async function lifecycleDurably(
  action: () => Promise<LifecycleResult>,
  label: string,
  hasPending: () => boolean,
): Promise<LifecycleResult | "pending"> {
  let waitMs = 5_000;

  for (;;) {
    try {
      return await action();
    } catch (error) {
      log.warn(`${label} failed; retrying with a durable timer`, {
        error: publicFailureForCode(failureType(error) ?? "ACTIVITY_FAILED").code,
      });

      if (await condition(hasPending, waitMs)) return "pending";
      waitMs = Math.min(waitMs * 2, 60_000);
    }
  }
}

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
    startToCloseTimeout: lifecycleStartToCloseMs(config),
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
          await prepareAndExecute(preparation, execution, runId);
        });
      } catch (error) {
        await recoverOrFinalize(preparation, execution, lifecycle, runId, error);
      } finally {
        activeScope = undefined;
        activeRunId = undefined;
      }

      runCount += 1;
      continue;
    }

    if (await condition(() => pending.length > 0, config.idlePauseMs)) continue;

    const paused = await lifecycleDurably(
      () => lifecycle.pauseWorkspace(threadId),
      "Workspace idle pause",
      () => pending.length > 0,
    );

    if (paused === "pending" || isDeferred(paused)) {
      await condition(() => pending.length > 0, config.cleanupMs);
      continue;
    }

    if (await condition(() => pending.length > 0, config.cleanupMs)) continue;

    const deleted = await lifecycleDurably(
      () => lifecycle.deleteWorkspace(threadId),
      "Workspace cleanup delete",
      () => pending.length > 0,
    );

    if (deleted === "pending" || isDeferred(deleted)) {
      await condition(() => pending.length > 0, config.cleanupMs);
      continue;
    }

    await condition(() => pending.length > 0);
  }
}
