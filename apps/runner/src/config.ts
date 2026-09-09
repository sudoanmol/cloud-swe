import { env } from "@cloud-swe/env/runner";

export interface RunnerWorkflowConfig {
  executionMode: "scripted" | "pi";
  sandboxProvider: "docker" | "freestyle";
  idlePauseMs: number;
  cleanupMs: number;
  maxRunMs: number;
  stepDelayMs: number;
  piProvider: string;
  piModel: string;
  piThinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
}

export interface RunnerConfig extends RunnerWorkflowConfig {
  freestyleApiKey: string | undefined;
  freestyleSnapshotId: string;
  freestyleIdleTimeoutSeconds: number;
  freestyleAutoDeleteSeconds: number;
  repositoryCloneTimeoutMs: number;
  repositoryMaxBytes: number;
  repositoryMinFreeBytes: number;
  aiGatewayApiKey: string | undefined;
}

export function loadRunnerConfig(): RunnerConfig {
  const config: RunnerConfig = {
    executionMode: env.RUNNER_EXECUTION_MODE,
    sandboxProvider: env.RUNNER_SANDBOX_PROVIDER,
    idlePauseMs: env.RUNNER_IDLE_PAUSE_MS,
    cleanupMs: env.RUNNER_CLEANUP_MS,
    maxRunMs: env.RUNNER_MAX_RUN_MS,
    stepDelayMs: env.RUNNER_STEP_DELAY_MS,
    freestyleApiKey: env.FREESTYLE_API_KEY,
    freestyleSnapshotId: env.FREESTYLE_SNAPSHOT_ID,
    freestyleIdleTimeoutSeconds: env.FREESTYLE_IDLE_TIMEOUT_SECONDS,
    freestyleAutoDeleteSeconds: env.FREESTYLE_AUTO_DELETE_SECONDS,
    repositoryCloneTimeoutMs: env.RUNNER_REPOSITORY_CLONE_TIMEOUT_MS,
    repositoryMaxBytes: env.RUNNER_REPOSITORY_MAX_BYTES,
    repositoryMinFreeBytes: env.RUNNER_REPOSITORY_MIN_FREE_BYTES,
    piProvider: env.PI_PROVIDER,
    piModel: env.PI_MODEL,
    aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
    piThinkingLevel: env.PI_THINKING_LEVEL,
  };
  if (config.executionMode === "pi" && config.sandboxProvider !== "freestyle")
    throw new Error(
      "RUNNER_EXECUTION_MODE=pi requires RUNNER_SANDBOX_PROVIDER=freestyle so Pi never runs against a local sandbox",
    );
  if (config.executionMode === "pi" && config.piProvider !== "vercel-ai-gateway")
    throw new Error("Pi execution currently requires PI_PROVIDER=vercel-ai-gateway");
  if (config.executionMode === "pi" && !config.freestyleApiKey)
    throw new Error("FREESTYLE_API_KEY is required when RUNNER_EXECUTION_MODE=pi");
  if (config.executionMode === "pi" && !config.aiGatewayApiKey)
    throw new Error("AI_GATEWAY_API_KEY is required when RUNNER_EXECUTION_MODE=pi");
  return config;
}

/** Only this credential-free shape may cross the Temporal workflow boundary. */
export function toWorkflowConfig(config: RunnerConfig): RunnerWorkflowConfig {
  return {
    executionMode: config.executionMode,
    sandboxProvider: config.sandboxProvider,
    idlePauseMs: config.idlePauseMs,
    cleanupMs: config.cleanupMs,
    maxRunMs: config.maxRunMs,
    stepDelayMs: config.stepDelayMs,
    piProvider: config.piProvider,
    piModel: config.piModel,
    piThinkingLevel: config.piThinkingLevel,
  };
}
