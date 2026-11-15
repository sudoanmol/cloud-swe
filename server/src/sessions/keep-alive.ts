/**
 * Path: server/src/sessions/keep-alive.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: A durable job that keeps the sandbox alive while a run is active and shortens its life once the run ends.
 */

import { catalogStub } from '../env.ts';
import { refreshGitAccessIfNeeded } from '../git/access.ts';
import { PollingJob } from '../polling-job.ts';
import { endCommandsOfDeletedSandbox } from '../sandbox/command-lifecycle.ts';
import { commandOperations } from '../sandbox/command-records.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { requireSession } from '../thread-store.ts';
import { workspaceSettings } from '../workspaces/settings.ts';

/** A run is active while Pi works on a submission or a command is still open. */
async function runActive(host: ToolHost): Promise<boolean> {
  return (await host.harness.session().busy()) || (await commandOperations(host)).length > 0;
}

/**
 * One keep-alive step; returns whether to run again.
 *
 * A sandbox pauses at its deadline whatever it is doing, so an active run resumes it and pushes the deadline out. Once
 * the run ends, one final renewal shortens it to a few minutes so the sandbox pauses soon and frees its slot. A failed
 * final renewal is retried by the same job; the existing deadline is the fallback.
 */
async function keepAliveTick(host: ToolHost): Promise<boolean> {
  const session = await requireSession(host.storage);
  const active = await runActive(host);

  const state = await catalogStub(host.env).keepAlive(session.id, session.workspace.id, active ? 'active' : 'finished');

  // Only a finished run reads `stopped` here, since an active one resumes the sandbox; either way nothing is left to
  // keep alive. A deleted sandbox took any command with it.
  if (state === 'deleted') await endCommandsOfDeletedSandbox(host);

  if (state !== 'running') return false;

  if (active) await refreshGitAccessIfNeeded(host);

  return active;
}

/** Starts ticking at once when watched. */
export const keepAliveJob = (host: () => ToolHost) =>
  new PollingJob({
    capability: 'keep-alive',
    job: 'keep-alive',
    step: () => keepAliveTick(host()),
    everyMs: () => workspaceSettings(host().env).keepAliveMs,
    firstAfterMs: 0,
  });
