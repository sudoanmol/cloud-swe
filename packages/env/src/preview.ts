import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export const env = createEnv({
  server: {
    /** Wildcard parent of preview hostnames, e.g. `p.example.com`. Unset disables previews. */
    PREVIEW_DOMAIN: z
      .string()
      .regex(/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/, "Lowercase hostname, no scheme")
      .optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
