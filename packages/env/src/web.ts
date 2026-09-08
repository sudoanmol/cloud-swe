import { createEnv } from "@t3-oss/env-nuxt";
import { z } from "zod";

import { loadRootEnv } from "./load-root-env";

loadRootEnv();

/**
 * Nuxt env validation - validates at build time when imported in nuxt.config.ts
 * For runtime access in components/plugins, use useRuntimeConfig() instead:
 *   const config = useRuntimeConfig()
 *   config.public.serverUrl (NUXT_PUBLIC_SERVER_URL maps to serverUrl)
 */
export const env = createEnv({
  client: {
    NUXT_PUBLIC_SERVER_URL: z.url(),
  },
  emptyStringAsUndefined: true,
});
