import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export const env = createEnv({
  server: {
    RUNNER_EXECUTION_MODE: z.enum(["scripted", "pi"]).default("scripted"),
    MODEL_CREDENTIALS_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    PRIMARY_GITHUB_ACCOUNT_ID: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    HOST: z.string().min(1).default("0.0.0.0"),
    MAX_ACTIVE_RUNS: z.coerce.number().int().min(1).max(10).default(5),
    SSE_POLL_MS: z.coerce.number().int().min(10).default(200),
    SSE_HEARTBEAT_MS: z.coerce.number().int().min(100).default(15_000),
    ALLOW_UNVERIFIED_COMPUTE: z.enum(["true", "false"]).optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
