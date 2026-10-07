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
    /** Separate from the model key; encrypts user environment values. */
    ENVIRONMENT_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    /** Comma-separated numeric GitHub account IDs allowed to run tasks. */
    ALLOWED_GITHUB_ACCOUNT_IDS: z
      .string()
      .regex(/^[1-9][0-9]*(,[1-9][0-9]*)*$/)
      .optional()
      .transform((value) => new Set(value?.split(",") ?? [])),
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    HOST: z.string().min(1).default("0.0.0.0"),
    MAX_ACTIVE_RUNS: z.coerce.number().int().min(1).max(10).default(5),
    SSE_POLL_MS: z.coerce.number().int().min(10).default(200),
    SSE_HEARTBEAT_MS: z.coerce.number().int().min(100).default(15_000),
    ALLOW_UNVERIFIED_COMPUTE: z.enum(["true", "false"]).optional(),
    /** Server-only DeepSeek title generation; never a user chat credential. */
    DEEPSEEK_API_URL: z.url().default("https://api.deepseek.com"),
    DEEPSEEK_API_KEY: z.string().min(1).optional(),
    /** Read-only workspace review; the runner owns every sandbox mutation. */
    MODAL_TOKEN_ID: z.string().min(1).optional(),
    MODAL_TOKEN_SECRET: z.string().min(1).optional(),
    MODAL_ENVIRONMENT: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
