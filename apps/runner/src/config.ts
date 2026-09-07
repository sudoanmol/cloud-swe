import { z } from "zod";
const schema = z.object({
  idlePauseMs: z.coerce.number().int().positive().default(30_000),
  cleanupMs: z.coerce.number().int().positive().default(3_600_000),
  maxRunMs: z.coerce.number().int().positive().default(120_000),
  stepDelayMs: z.coerce.number().int().nonnegative().default(500),
});
export type RunnerConfig = z.infer<typeof schema>;
export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return schema.parse({
    idlePauseMs: env.RUNNER_IDLE_PAUSE_MS,
    cleanupMs: env.RUNNER_CLEANUP_MS,
    maxRunMs: env.RUNNER_MAX_RUN_MS,
    stepDelayMs: env.RUNNER_STEP_DELAY_MS,
  });
}
