import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    TEMPORAL_ADDRESS: z.string().min(1).default("127.0.0.1:7233"),
    TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
    TEMPORAL_TASK_QUEUE: z.string().min(1).default("cloud-swe-runner"),
    RUNNER_EXECUTION_MODE: z.enum(["scripted", "pi"]).default("scripted"),
    RUNNER_SANDBOX_PROVIDER: z.enum(["docker", "freestyle"]).default("docker"),
    RUNNER_IDLE_PAUSE_MS: z.coerce.number().int().positive().default(30_000),
    RUNNER_CLEANUP_MS: z.coerce.number().int().positive().default(3_600_000),
    RUNNER_MAX_RUN_MS: z.coerce.number().int().positive().default(120_000),
    RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS: z.coerce.number().int().positive().default(420_000),
    RUNNER_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    RUNNER_COMMAND_RECONCILE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    RUNNER_COMMAND_OUTPUT_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(4_194_304)
      .default(262_144),
    RUNNER_CHECKPOINT_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(16_777_216)
      .default(4_194_304),
    RUNNER_ACTIVITY_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    RUNNER_ACTIVITY_RETRY_WINDOW_MS: z.coerce.number().int().positive().default(1_500_000),
    RUNNER_STEP_DELAY_MS: z.coerce.number().int().nonnegative().default(500),
    RUNNER_ACTIVITY_CONCURRENCY: z.coerce.number().int().positive().default(4),
    RUNNER_REPOSITORY_CLONE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(240_000)
      .default(240_000),
    RUNNER_REPOSITORY_MAX_BYTES: z.coerce.number().int().positive().default(4_294_967_296),
    RUNNER_REPOSITORY_MIN_FREE_BYTES: z.coerce.number().int().positive().default(2_147_483_648),
    RUNNER_DOCKER_IMAGE: z
      .string()
      .min(1)
      .default(
        "ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517",
      ),
    FREESTYLE_API_KEY: z.string().min(1).optional(),
    FREESTYLE_SNAPSHOT_ID: z.string().min(1).default("freestyle/ubuntu-sm"),
    FREESTYLE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(-1).default(-1),
    FREESTYLE_MAX_RUN_SECONDS: z.coerce.number().int().positive().default(900),
    FREESTYLE_AUTO_DELETE_SECONDS: z.coerce.number().int().min(-1).default(14_400),
    PI_PROVIDER: z.string().min(1).default("vercel-ai-gateway"),
    PI_MODEL: z.string().min(1).default("meta/muse-spark-1.3-contributor"),
    AI_GATEWAY_API_KEY: z.string().min(1).optional(),
    PI_THINKING_LEVEL: z.enum(["off", "minimal", "low", "medium", "high"]).default("medium"),
    LOG_LEVEL: z.string().min(1).default("info"),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
