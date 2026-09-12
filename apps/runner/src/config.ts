import { env } from "@cloud-swe/env/runner";

/** Durable scheduling settings. Worker/provider/model settings never enter workflow history. */
export interface RunnerWorkflowConfig {
  ownerMaxRunMs?: number;
  idlePauseMs: number;
  cleanupMs: number;
  maxRunMs: number;
  workspacePreparationTimeoutMs: number;
  providerTimeoutMs: number;
  commandReconcileTimeoutMs: number;
  activityRetryMaxAttempts: number;
  activityRetryWindowMs: number;
}

export interface RunnerConfig extends RunnerWorkflowConfig {
  freestyleOwnerMaxRunSeconds?: number;
  freestyleVmLimit?: number;
  demoMonthlyVmSeconds?: number;
  executionMode: "scripted" | "pi";
  sandboxProvider: "docker" | "freestyle";
  stepDelayMs: number;
  dockerImage: string;
  piProvider: string;
  piModel: string;
  piThinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
  freestyleApiKey: string | undefined;
  freestyleSnapshotId: string;
  freestyleIdleTimeoutSeconds: number;
  /** Pause one continuous Freestyle run after this many seconds. Not auto-delete. */
  freestyleMaxRunSeconds: number;
  freestyleAutoDeleteSeconds: number;
  repositoryCloneTimeoutMs: number;
  repositoryMaxBytes: number;
  repositoryMinFreeBytes: number;
  commandOutputMaxBytes: number;
  checkpointMaxBytes: number;
  aiGatewayApiKey: string | undefined;
}

export function validateRunnerConfig(config: RunnerConfig, _production: boolean): RunnerConfig {
  if (config.executionMode === "pi" && config.sandboxProvider !== "freestyle")
    throw new Error("RUNNER_EXECUTION_MODE=pi requires RUNNER_SANDBOX_PROVIDER=freestyle");

  if (config.sandboxProvider === "freestyle" && !config.freestyleApiKey)
    throw new Error("FREESTYLE_API_KEY is required for the Freestyle provider");

  if (config.sandboxProvider === "freestyle" && !config.freestyleSnapshotId.trim())
    throw new Error("FREESTYLE_SNAPSHOT_ID is required for the Freestyle provider");

  if (config.executionMode === "pi" && !config.aiGatewayApiKey)
    throw new Error("AI_GATEWAY_API_KEY is required when RUNNER_EXECUTION_MODE=pi");

  if (
    config.sandboxProvider === "freestyle" &&
    (!Number.isFinite(config.freestyleAutoDeleteSeconds) || config.freestyleAutoDeleteSeconds <= 0)
  )
    throw new Error(
      "FREESTYLE_AUTO_DELETE_SECONDS must be a finite positive retention when using the Freestyle provider",
    );

  if (
    config.sandboxProvider === "freestyle" &&
    config.freestyleMaxRunSeconds * 1_000 < config.workspacePreparationTimeoutMs + config.maxRunMs
  )
    throw new Error(
      "FREESTYLE_MAX_RUN_SECONDS must cover workspace preparation and active execution",
    );

  if (
    (config.freestyleOwnerMaxRunSeconds ?? 4500) * 1000 <
    config.workspacePreparationTimeoutMs +
      (config.ownerMaxRunMs ?? 3600000) +
      60000 +
      config.idlePauseMs
  )
    throw new Error("Owner provider runtime must cover preparation, execution, and idle grace");

  if (
    config.freestyleMaxRunSeconds * 1000 <
    config.workspacePreparationTimeoutMs + config.maxRunMs + 60000 + config.idlePauseMs
  )
    throw new Error("Demo provider runtime must cover preparation, execution, and idle grace");

  const preparationMinimum =
    config.repositoryCloneTimeoutMs +
    config.providerTimeoutMs * 2 +
    config.commandReconcileTimeoutMs +
    10_000;

  if (config.workspacePreparationTimeoutMs < preparationMinimum)
    throw new Error(
      "RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS must cover cloning, provider startup, reconciliation, and cleanup grace",
    );
  const longestAttempt = Math.max(config.workspacePreparationTimeoutMs, config.maxRunMs);

  if (config.activityRetryWindowMs < longestAttempt * config.activityRetryMaxAttempts + 30_000)
    throw new Error(
      "RUNNER_ACTIVITY_RETRY_WINDOW_MS must cover all configured attempts and retry backoff",
    );

  return config;
}

export function loadRunnerConfig(): RunnerConfig {
  return validateRunnerConfig(
    {
      ownerMaxRunMs: env.RUNNER_OWNER_MAX_RUN_MS,
      freestyleOwnerMaxRunSeconds: env.FREESTYLE_OWNER_MAX_RUN_SECONDS,
      freestyleVmLimit: env.FREESTYLE_VM_LIMIT,
      demoMonthlyVmSeconds: env.DEMO_MONTHLY_VM_SECONDS,
      executionMode: env.RUNNER_EXECUTION_MODE,
      sandboxProvider: env.RUNNER_SANDBOX_PROVIDER,
      idlePauseMs: env.RUNNER_IDLE_PAUSE_MS,
      cleanupMs: env.RUNNER_CLEANUP_MS,
      maxRunMs: env.RUNNER_MAX_RUN_MS,
      workspacePreparationTimeoutMs: env.RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS,
      providerTimeoutMs: env.RUNNER_PROVIDER_TIMEOUT_MS,
      commandReconcileTimeoutMs: env.RUNNER_COMMAND_RECONCILE_TIMEOUT_MS,
      activityRetryMaxAttempts: env.RUNNER_ACTIVITY_RETRY_MAX_ATTEMPTS,
      activityRetryWindowMs: env.RUNNER_ACTIVITY_RETRY_WINDOW_MS,
      stepDelayMs: env.RUNNER_STEP_DELAY_MS,
      dockerImage: env.RUNNER_DOCKER_IMAGE,
      freestyleApiKey: env.FREESTYLE_API_KEY,
      freestyleSnapshotId: env.FREESTYLE_SNAPSHOT_ID,
      freestyleIdleTimeoutSeconds: env.FREESTYLE_IDLE_TIMEOUT_SECONDS,
      freestyleMaxRunSeconds: env.FREESTYLE_MAX_RUN_SECONDS,
      freestyleAutoDeleteSeconds: env.FREESTYLE_AUTO_DELETE_SECONDS,
      repositoryCloneTimeoutMs: env.RUNNER_REPOSITORY_CLONE_TIMEOUT_MS,
      repositoryMaxBytes: env.RUNNER_REPOSITORY_MAX_BYTES,
      repositoryMinFreeBytes: env.RUNNER_REPOSITORY_MIN_FREE_BYTES,
      commandOutputMaxBytes: env.RUNNER_COMMAND_OUTPUT_MAX_BYTES,
      checkpointMaxBytes: env.RUNNER_CHECKPOINT_MAX_BYTES,
      piProvider: env.PI_PROVIDER,
      piModel: env.PI_MODEL,
      aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
      piThinkingLevel: env.PI_THINKING_LEVEL,
    },
    env.NODE_ENV === "production",
  );
}

export function toWorkflowConfig(config: RunnerConfig): RunnerWorkflowConfig {
  return {
    ownerMaxRunMs: config.ownerMaxRunMs,
    idlePauseMs: config.idlePauseMs,
    cleanupMs: config.cleanupMs,
    maxRunMs: config.maxRunMs,
    workspacePreparationTimeoutMs: config.workspacePreparationTimeoutMs,
    providerTimeoutMs: config.providerTimeoutMs,
    commandReconcileTimeoutMs: config.commandReconcileTimeoutMs,
    activityRetryMaxAttempts: config.activityRetryMaxAttempts,
    activityRetryWindowMs: config.activityRetryWindowMs,
  };
}
