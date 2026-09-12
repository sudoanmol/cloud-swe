import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export const env = createEnv({
  server: {
    GIT_BROKER_URL: z
      .url()
      .refine((value) => {
        const url = new URL(value);

        return (
          url.pathname === "/" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      }, "Git broker URL requires HTTPS outside localhost")
      .optional(),
    GIT_BROKER_SECRET: z.string().min(32).optional(),
    GIT_BROKER_STORAGE: z.string().min(1).optional(),
    GIT_BROKER_MAX_BYTES: z.coerce.number().int().positive().default(4_294_967_296),
    GIT_BROKER_MIN_FREE_BYTES: z.coerce.number().int().positive().default(2_147_483_648),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
