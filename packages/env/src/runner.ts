import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    TEMPORAL_ADDRESS: z.string().min(1).default("127.0.0.1:7233"),
    TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
    TEMPORAL_TASK_QUEUE: z.string().min(1).default("cloud-swe-runner"),
    RUNNER_EXECUTION_MODE: z.enum(["scripted", "pi"]).default("scripted"),
    RUNNER_SANDBOX_PROVIDER: z.enum(["docker", "freestyle"]).default("docker"),
    RUNNER_IDLE_PAUSE_MS: z.coerce.number().int().positive().default(30_000),
    RUNNER_CLEANUP_MS: z.coerce.number().int().positive().default(3_600_000),
    RUNNER_MAX_RUN_MS: z.coerce.number().int().positive().default(120_000),
    RUNNER_STEP_DELAY_MS: z.coerce.number().int().nonnegative().default(500),
    RUNNER_ACTIVITY_CONCURRENCY: z.coerce.number().int().positive().default(4),
    RUNNER_DOCKER_IMAGE: z
      .string()
      .min(1)
      .default(
        "ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517",
      ),
    FREESTYLE_API_KEY: z.string().min(1).optional(),
    FREESTYLE_SNAPSHOT_ID: z.string().min(1).default("freestyle/ubuntu-sm"),
    FREESTYLE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(-1).default(-1),
    FREESTYLE_AUTO_DELETE_SECONDS: z.coerce.number().int().min(-1).default(-1),
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
