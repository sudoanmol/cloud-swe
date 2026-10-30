/**
 * Path: server/src/workspaces/settings.ts
 * Used by: server/src/sessions/{catalog,create}.ts, server/src/tools/keep-alive.ts.
 * Purpose: The optional lifecycle numbers from the environment, parsed once with their defaults.
 */
import { z } from 'zod';

import type { Env } from '../env';

/** After a run ends, Boat stops the sandbox this long later, so a finished session frees its slot quickly. */
export const IDLE_TTL_SECONDS = 600;

const Settings = z.object({
  /** Sandboxes allowed to run at once: the only product limit. */
  MAX_SANDBOXES: z.coerce.number().int().positive().default(4),
  /** A sandbox is deleted after this many days without activity. */
  SANDBOX_DELETE_AFTER_DAYS: z.coerce.number().positive().default(7),
  /** How often an active run renews Boat's auto-stop deadline. */
  KEEPALIVE_INTERVAL_SECONDS: z.coerce.number().positive().default(120),
});

export function workspaceSettings(env: Pick<Env, keyof z.input<typeof Settings>>) {
  const settings = Settings.parse(env);

  return {
    maxSandboxes: settings.MAX_SANDBOXES,
    deleteAfterMs: settings.SANDBOX_DELETE_AFTER_DAYS * 86_400_000,
    keepAliveMs: settings.KEEPALIVE_INTERVAL_SECONDS * 1000,
    // Three missed renewals before Boat stops a sandbox whose run is still going.
    ttlSeconds: Math.ceil(settings.KEEPALIVE_INTERVAL_SECONDS * 3),
  };
}
