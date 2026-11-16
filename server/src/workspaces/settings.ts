/**
 * Path: server/src/workspaces/settings.ts
 * Used by: server/src/sessions/{create,keep-alive,workspace-lifecycle,workspace-ready}.ts, server/src/workspaces/e2b.ts.
 * Purpose: The optional lifecycle numbers from the environment, parsed once with their defaults.
 */

import { z } from 'zod';

import type { Env } from '../env.ts';
import { apiError } from '../errors.ts';

/** After a run ends, the provider stops the sandbox this long later, so a finished session frees its slot quickly. */
export const IDLE_TTL_SECONDS = 600;

const Settings = z.object({
  MAX_SANDBOXES: z.coerce.number().int().positive().default(4),
  SANDBOX_DELETE_AFTER_DAYS: z.coerce.number().positive().default(7),
  KEEPALIVE_INTERVAL_SECONDS: z.coerce.number().positive().default(120),
});

export function workspaceSettings(env: Pick<Env, keyof z.input<typeof Settings>>) {
  const settings = Settings.parse(env);

  return {
    maxSandboxes: settings.MAX_SANDBOXES,
    deleteAfterMs: settings.SANDBOX_DELETE_AFTER_DAYS * 86_400_000,
    keepAliveMs: settings.KEEPALIVE_INTERVAL_SECONDS * 1000,
    // Three missed renewals before the provider stops a sandbox whose run is still going.
    ttlSeconds: Math.ceil(settings.KEEPALIVE_INTERVAL_SECONDS * 3),
  };
}

export const sandboxLimitParams = (env: Pick<Env, 'MAX_SANDBOXES'>) => ({ limit: workspaceSettings(env).maxSandboxes });

/** The 409 for a session creation or message that needs a sandbox slot while MAX_SANDBOXES are running. */
export const sandboxLimitError = (env: Pick<Env, 'MAX_SANDBOXES'>) =>
  apiError('sandbox_limit_reached', sandboxLimitParams(env));
