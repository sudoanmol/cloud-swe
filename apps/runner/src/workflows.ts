import { failureIdentities } from "./failure.js";
import type { RetryPolicy } from "@temporalio/common";
import {
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  log,
  proxyActivities,
  patched,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { createActivities } from "./activities.js";
import type { LifecycleResult } from "./activity-support.js";
import type { RunnerWorkflowConfig } from "./config.js";
import { publicFailureForCode } from "@cloud-swe/db/public-failure";

type Activities = ReturnType<typeof createActivities>;

type Input = RunnerWorkflowConfig & { pending?: string[] };

type WorkflowInput = Partial<RunnerWorkflowConfig> & { pending?: string[] };

export const startRun = defineSignal<[string]>("startRun");

export const gitDecision = defineSignal<[string]>("gitDecision");

export const questionAnswered = defineSignal<[string]>("questionAnswered");

export const cancelRun = defineSignal<[string]>("cancelRun");

/** The review panel asks for a paused workspace; the idle pause re-arms after it. */
export const wakeWorkspace = defineSignal("wakeWorkspace");

/** The owner deleted the thread: delete its workspace, purge its rows, and finish. */
export const deleteThread = defineSignal("deleteThread");

const nonRetryableActivityErrors = [
  "PROVIDER_CAPACITY",
  "RESOURCE_DISCOVERY_LIMIT",
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
  "ATTACHMENT_INVALID",
  "ATTACHMENT_OBJECT_INVALID",
  "ATTACHMENT_REFERENCE_INVALID",
];

const defaultWorkflowConfig: RunnerWorkflowConfig = {
  idlePauseMs: 600_000,
  maxRunMs: 3_600_000,
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
  } satisfies RetryPolicy;
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
  failureCode?: string,
): Promise<void> {
  let waitMs = 1_000;

  for (;;) {
    try {
      await CancellationScope.nonCancellable(() =>
        patched("finalizer-failure-code-v1")
          ? lifecycle.finalizeRun(runId, status, failureMessage, failureCode)
          : lifecycle.finalizeRun(runId, status, failureMessage),
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

type ExecutionPolicy = {
  waitForApproval: (runId: string) => Promise<void>;
  waitForQuestions: (runId: string) => Promise<void>;
};

async function prepareAndExecute(
  preparation: Activities,
  execution: Activities,
  runId: string,
  policy: ExecutionPolicy,
) {
  const prepared = await preparation.prepareWorkspace(runId);

  if (prepared.kind === "prepared") {
    let result = await execution.runExecution(runId);

    while (result) {
      if (result.kind === "awaiting_approval") await policy.waitForApproval(runId);
      else await policy.waitForQuestions(runId);
      const resumed = await preparation.prepareWorkspace(runId);

      if (resumed.kind !== "prepared") return resumed;

      if (result.kind === "awaiting_approval") await preparation.resumeApproval(runId);
      else await preparation.resumeQuestions(runId);
      result = await execution.runExecution(runId);
    }
  }

  return prepared;
}

async function recoverOrFinalize(
  preparation: Activities,
  execution: Activities,
  lifecycle: Activities,
  runId: string,
  policy: ExecutionPolicy,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recovery receives an activity rejection and maps only its identity.
  error: unknown,
) {
  if (failureType(error) === "CHECKPOINT_OWNERSHIP_LOST") return;

  if (!isCancellation(error) && needsWorkspacePreparation(error)) {
    try {
      const prepared = await prepareAndExecute(preparation, execution, runId, policy);

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
        failureType(recoveryError),
      );

      return;
    }
  }

  await finalizeRunDurably(
    lifecycle,
    runId,
    isCancellation(error) ? "cancelled" : "failed",
    runFailureMessage(error),
    failureType(error),
  );
}

async function lifecycleDurably<T>(
  action: () => Promise<T>,
  label: string,
  hasPending: () => boolean,
): Promise<T | "pending"> {
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

  const scopedRecovery = patched("recovery-cancellation-scope-v1");
  const handoffWake = patched("browser-handoff-wake-v1");

  // The run deadline survives retries through agent_started_at, so one schedule
  // deadline just above it bounds every attempt.
  const execution = proxyActivities<Activities>({
    startToCloseTimeout: config.maxRunMs + 30_000,
    scheduleToCloseTimeout: config.maxRunMs + 60_000,
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

  let decisionVersion = 0;
  let answerVersion = 0;
  let wakeRequested = false;
  setHandler(gitDecision, () => {
    decisionVersion += 1;
  });
  setHandler(questionAnswered, () => {
    answerVersion += 1;
  });

  /**
   * Waits for a person's answer or decision. The workspace stays awake for one
   * idle period so a quick reply resumes without a restore. A deferred pause
   * retries after another idle period.
   */
  async function waitForPerson(
    pause: () => Promise<LifecycleResult | void>,
    status: () => Promise<{ pending: boolean; expiresAt?: number }>,
    version: () => number,
    wake?: () => ReturnType<Activities["prepareWorkspace"]>,
  ) {
    let pauseAt: number | null = Date.now() + config.idlePauseMs;

    for (;;) {
      const observed = version();
      const current = await status();

      if (!current.pending) return;

      if (wake && wakeRequested) {
        wakeRequested = false;
        await lifecycleDurably(wake, "Handoff workspace wake", () => version() !== observed);
        pauseAt = Date.now() + config.idlePauseMs;
        continue;
      }

      const changedSinceRead = () => version() !== observed || Boolean(wake && wakeRequested);
      const deadline = Math.min(current.expiresAt ?? Infinity, pauseAt ?? Infinity);

      if (deadline === Infinity) {
        await condition(changedSinceRead);
        continue;
      }

      const changed = await condition(changedSinceRead, Math.max(1, deadline - Date.now()));

      if (changed || pauseAt === null || Date.now() < pauseAt) continue;
      const result = await pause();
      // New activity results carry the remaining review grace, capped before
      // the provider timeout. Older histories retain the original idle retry.
      pauseAt =
        result?.outcome === "deferred"
          ? Date.now() + (result.reason === "in-use" ? result.retryAfterMs : config.idlePauseMs)
          : null;
    }
  }

  const policy: ExecutionPolicy = {
    waitForApproval: (runId) =>
      waitForPerson(
        () => lifecycle.pauseForApproval(runId),
        () => lifecycle.approvalStatus(runId),
        () => decisionVersion,
      ),
    waitForQuestions: (runId) =>
      waitForPerson(
        () => lifecycle.pauseForQuestions(runId),
        () => lifecycle.questionStatus(runId),
        () => answerVersion,
        handoffWake ? () => preparation.prepareWorkspace(runId) : undefined,
      ),
  };

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

  // Replay-safe without a patch: histories before this signal never set it.
  setHandler(wakeWorkspace, () => {
    wakeRequested = true;
  });
  // Replay-safe without a patch for the same reason as the wake signal.
  let deleteRequested = false;
  setHandler(deleteThread, () => {
    deleteRequested = true;
  });
  const hasWork = () => pending.length > 0 || wakeRequested || deleteRequested;

  /**
   * True once an idle period passes with no work. Review panel reads defer
   * the pause, but never past the sandbox's hard timeout.
   */
  async function idleElapsed(): Promise<boolean> {
    let wait = config.idlePauseMs;

    for (;;) {
      if (await condition(hasWork, wait)) return false;

      try {
        wait = await lifecycle.idleDeferralMs(threadId, config.idlePauseMs);
      } catch {
        return true;
      }

      if (wait <= 0) return true;
    }
  }

  for (;;) {
    // Deletion admits no new runs, so nothing is pending. Retries until the
    // workspace is gone: the delivered signal is not redelivered.
    if (deleteRequested) {
      await lifecycleDurably(
        () => lifecycle.deleteThread(threadId),
        "Thread deletion",
        () => false,
      );

      return;
    }

    // A pending wake is served first: continue-as-new carries only `pending`.
    if ((runCount >= 100 || workflowInfo().continueAsNewSuggested) && !wakeRequested) {
      await continueAsNew<typeof threadWorkflow>(threadId, { ...config, pending });
    }

    const runId = pending.shift();

    if (runId !== undefined) {
      activeRunId = runId;

      try {
        await CancellationScope.cancellable(async () => {
          activeScope = CancellationScope.current();

          try {
            await prepareAndExecute(preparation, execution, runId, policy);
          } catch (error) {
            if (!scopedRecovery) throw error;
            await recoverOrFinalize(preparation, execution, lifecycle, runId, policy, error);
          }
        });
      } catch (error) {
        await recoverOrFinalize(preparation, execution, lifecycle, runId, policy, error);
      } finally {
        activeScope = undefined;
        activeRunId = undefined;
      }

      runCount += 1;
      continue;
    }

    if (wakeRequested) {
      wakeRequested = false;

      try {
        await lifecycle.wakeWorkspace(threadId);
      } catch (error) {
        // The panel asks again; a failed wake must not hold the lifecycle loop.
        log.warn("Workspace wake failed", {
          error: publicFailureForCode(failureType(error) ?? "ACTIVITY_FAILED").code,
        });
      }

      continue;
    }

    if (!(await idleElapsed())) continue;

    const paused = await lifecycleDurably(
      () => lifecycle.pauseWorkspace(threadId),
      "Workspace idle pause",
      () => pending.length > 0,
    );

    // A deferred pause retries after another idle period, inside the
    // sandbox's hard lifetime.
    if (paused === "pending" || isDeferred(paused)) {
      await condition(hasWork, config.idlePauseMs);
      continue;
    }

    // A paused workspace stays until the next run or wake. Modal keeps its
    // exit snapshot for 30 days; a later run past that rebuilds it.
    await condition(hasWork);
  }
}
