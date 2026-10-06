import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export const env = createEnv({
  server: {
    GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
    GATEWAY_HOST: z.string().min(1).default("0.0.0.0"),
    /** Previews mint connect tokens for running sandboxes; the gateway never mutates them. */
    MODAL_TOKEN_ID: z.string().min(1).optional(),
    MODAL_TOKEN_SECRET: z.string().min(1).optional(),
    MODAL_ENVIRONMENT: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
