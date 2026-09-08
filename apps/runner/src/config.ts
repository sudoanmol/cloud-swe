import { env } from "@cloud-swe/env/runner";

export interface RunnerConfig {
  idlePauseMs: number;
  cleanupMs: number;
  maxRunMs: number;
  stepDelayMs: number;
}

export function loadRunnerConfig(): RunnerConfig {
  return {
    idlePauseMs: env.RUNNER_IDLE_PAUSE_MS,
    cleanupMs: env.RUNNER_CLEANUP_MS,
    maxRunMs: env.RUNNER_MAX_RUN_MS,
    stepDelayMs: env.RUNNER_STEP_DELAY_MS,
  };
}
