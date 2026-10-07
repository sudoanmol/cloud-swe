import { env as gitEnv } from "@cloud-swe/env/git";
import { browserConfig, type BrowserConfig } from "@cloud-swe/env/browser";
import { env as previewEnv } from "@cloud-swe/env/preview";
import { env } from "@cloud-swe/env/runner";

/** Durable scheduling settings. Worker/provider/model settings never enter workflow history. */
export interface RunnerWorkflowConfig {
  idlePauseMs: number;
  maxRunMs: number;
  workspacePreparationTimeoutMs: number;
  providerTimeoutMs: number;
  commandReconcileTimeoutMs: number;
  activityRetryMaxAttempts: number;
  activityRetryWindowMs: number;
}

export interface RunnerConfig extends RunnerWorkflowConfig {
  gitBroker?: { url: string; secret: string };
  executionMode: "scripted" | "pi";
  sandboxProvider: "docker" | "modal";
  stepDelayMs: number;
  dockerImage: string;
  modelCredentialsEncryptionKey?: string;
  composioApiKey?: string;
  /** Wildcard parent of preview hostnames; absent when previews are off. */
  previewDomain?: string;
  /** The hosted agent browser; absent when it is off. */
  browser?: BrowserConfig;
  modal?: ModalConfig;
  repositoryCloneTimeoutMs: number;
  repositoryMaxBytes: number;
  repositoryMinFreeBytes: number;
  commandOutputMaxBytes: number;
  checkpointMaxBytes: number;
}

interface ModalConfig {
  tokenId: string;
  tokenSecret: string;
  environment?: string;
  appName: string;
  imageName: string;
  sandboxLimit: number;
  /** Hard lifetime of one sandbox. A restore starts a new lifetime. */
  maxRunSeconds: number;
}

export function validateRunnerConfig(config: RunnerConfig): RunnerConfig {
  if (config.executionMode === "pi" && config.sandboxProvider !== "modal")
    throw new Error("RUNNER_EXECUTION_MODE=pi requires RUNNER_SANDBOX_PROVIDER=modal");

  if (config.sandboxProvider === "modal" && !config.modal)
    throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required for the Modal provider");

  if (config.executionMode === "pi" && !config.modelCredentialsEncryptionKey)
    throw new Error("MODEL_CREDENTIALS_ENCRYPTION_KEY is required when RUNNER_EXECUTION_MODE=pi");

  if (
    config.modal &&
    config.modal.maxRunSeconds * 1000 <
      config.workspacePreparationTimeoutMs + config.maxRunMs + 60000 + config.idlePauseMs
  )
    throw new Error("Sandbox lifetime must cover preparation, execution, and idle grace");

  const preparationMinimum =
    config.repositoryCloneTimeoutMs +
    config.providerTimeoutMs * 2 +
    config.commandReconcileTimeoutMs +
    10_000;

  if (config.workspacePreparationTimeoutMs < preparationMinimum)
    throw new Error(
      "RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS must cover cloning, provider startup, reconciliation, and cleanup grace",
    );

  // Execution has its own schedule deadline; the shared retry window covers preparation.
  if (
    config.activityRetryWindowMs <
    config.workspacePreparationTimeoutMs * config.activityRetryMaxAttempts + 30_000
  )
    throw new Error(
      "RUNNER_ACTIVITY_RETRY_WINDOW_MS must cover all configured attempts and retry backoff",
    );

  return config;
}

export function loadRunnerConfig(): RunnerConfig {
  return validateRunnerConfig({
    gitBroker:
      gitEnv.GIT_BROKER_URL && gitEnv.GIT_BROKER_SECRET
        ? { url: gitEnv.GIT_BROKER_URL.replace(/\/$/, ""), secret: gitEnv.GIT_BROKER_SECRET }
        : undefined,
    executionMode: env.RUNNER_EXECUTION_MODE,
    sandboxProvider: env.RUNNER_SANDBOX_PROVIDER,
    idlePauseMs: env.RUNNER_IDLE_PAUSE_MS,
    maxRunMs: env.RUNNER_MAX_RUN_MS,
    workspacePreparationTimeoutMs: env.RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS,
    providerTimeoutMs: env.RUNNER_PROVIDER_TIMEOUT_MS,
    commandReconcileTimeoutMs: env.RUNNER_COMMAND_RECONCILE_TIMEOUT_MS,
    activityRetryMaxAttempts: env.RUNNER_ACTIVITY_RETRY_MAX_ATTEMPTS,
    activityRetryWindowMs: env.RUNNER_ACTIVITY_RETRY_WINDOW_MS,
    stepDelayMs: env.RUNNER_STEP_DELAY_MS,
    dockerImage: env.RUNNER_DOCKER_IMAGE,
    modal:
      env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET
        ? {
            tokenId: env.MODAL_TOKEN_ID,
            tokenSecret: env.MODAL_TOKEN_SECRET,
            environment: env.MODAL_ENVIRONMENT,
            appName: env.MODAL_APP_NAME,
            imageName: env.MODAL_IMAGE_NAME,
            sandboxLimit: env.MODAL_SANDBOX_LIMIT,
            maxRunSeconds: env.MODAL_MAX_RUN_SECONDS,
          }
        : undefined,
    repositoryCloneTimeoutMs: env.RUNNER_REPOSITORY_CLONE_TIMEOUT_MS,
    repositoryMaxBytes: env.RUNNER_REPOSITORY_MAX_BYTES,
    repositoryMinFreeBytes: env.RUNNER_REPOSITORY_MIN_FREE_BYTES,
    commandOutputMaxBytes: env.RUNNER_COMMAND_OUTPUT_MAX_BYTES,
    checkpointMaxBytes: env.RUNNER_CHECKPOINT_MAX_BYTES,
    modelCredentialsEncryptionKey: env.MODEL_CREDENTIALS_ENCRYPTION_KEY,
    composioApiKey: env.COMPOSIO_API_KEY,
    previewDomain: previewEnv.PREVIEW_DOMAIN,
    browser: browserConfig(),
  });
}

export function toWorkflowConfig(config: RunnerConfig): RunnerWorkflowConfig {
  return {
    idlePauseMs: config.idlePauseMs,
    maxRunMs: config.maxRunMs,
    workspacePreparationTimeoutMs: config.workspacePreparationTimeoutMs,
    providerTimeoutMs: config.providerTimeoutMs,
    commandReconcileTimeoutMs: config.commandReconcileTimeoutMs,
    activityRetryMaxAttempts: config.activityRetryMaxAttempts,
    activityRetryWindowMs: config.activityRetryWindowMs,
  };
}
