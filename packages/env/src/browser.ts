import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export const env = createEnv({
  server: {
    /** Hosted agent browsers; the key stays on the server, runner, and gateway. */
    KERNEL_API_KEY: z.string().min(1).optional(),
    /** The gateway's CDP relay, e.g. `wss://gateway.example.com/cdp`; the sandbox connects here. */
    BROWSER_RELAY_URL: z
      .url()
      .refine((value) => {
        const url = new URL(value);

        return (
          url.protocol === "wss:" ||
          (url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        );
      }, "The browser relay requires wss:// outside localhost")
      .optional(),
    /** Signs the sandbox's relay capability; shared by the runner and the gateway. */
    BROWSER_RELAY_SECRET: z.string().min(32).optional(),
    /** The runner's idle pause; an unwatched browser ends on the same schedule. */
    RUNNER_IDLE_PAUSE_MS: z.coerce.number().int().positive().default(600_000),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});

/** The hosted browser is configured only as a whole; unset disables it. */
export function browserConfig() {
  const { KERNEL_API_KEY, BROWSER_RELAY_URL, BROWSER_RELAY_SECRET } = env;

  if (!KERNEL_API_KEY && !BROWSER_RELAY_URL && !BROWSER_RELAY_SECRET) return undefined;

  if (!KERNEL_API_KEY || !BROWSER_RELAY_URL || !BROWSER_RELAY_SECRET)
    throw new Error("Set KERNEL_API_KEY, BROWSER_RELAY_URL, and BROWSER_RELAY_SECRET together");

  return {
    kernelApiKey: KERNEL_API_KEY,
    relayUrl: BROWSER_RELAY_URL,
    relaySecret: BROWSER_RELAY_SECRET,
    idleSeconds: Math.min(259_200, Math.max(10, Math.ceil(env.RUNNER_IDLE_PAUSE_MS / 1_000))),
  };
}

export type BrowserConfig = NonNullable<ReturnType<typeof browserConfig>>;
