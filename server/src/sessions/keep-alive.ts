/**
 * Path: server/src/sessions/keep-alive.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: A durable job that keeps the sandbox alive while a run is active and shortens its life once the run ends.
 */

import { LifecycleCapability, type LifecycleJobOutcome } from 'agents/lifecycle';

import { catalogStub } from '../env.ts';
import { refreshGitAccessIfNeeded } from '../git/access.ts';
import { endCommandsOfStoppedSandbox } from '../sandbox/command-lifecycle.ts';
import { commandOperations } from '../sandbox/command-records.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { requireSession } from '../thread-store.ts';
import { workspaceSettings } from '../workspaces/settings.ts';

const JOB = 'keep-alive';

/** A run is active while Pi works on a submission or a command is still open. */
async function runActive(host: ToolHost): Promise<boolean> {
  return (await host.harness.session().busy()) || (await commandOperations(host)).length > 0;
}

/**
 * One keep-alive step; returns whether to run again.
 *
 * A sandbox stops at its auto-stop deadline whatever it is doing, so an active run pushes the deadline out. Once the
 * run ends, one final renewal shortens it to a few minutes so the sandbox stops soon and frees its slot. A failed final
 * renewal is retried by the same job; the existing deadline is the fallback.
 */
async function keepAliveTick(host: ToolHost): Promise<boolean> {
  const session = await requireSession(host.storage);
  const active = await runActive(host);

  const state = await catalogStub(host.env).keepAlive(session.id, session.workspace.id, active ? 'active' : 'finished');

  if (state === 'stopped' || state === 'deleted') {
    // The sandbox is gone from under any command, and there is nothing left to keep alive. An active run on E2B never
    // gets here stopped, because it resumes instead.
    await endCommandsOfStoppedSandbox(host);

    return false;
  }

  if (active) await refreshGitAccessIfNeeded(host);

  return active;
}

export class KeepAlive extends LifecycleCapability {
  readonly host: () => ToolHost;

  constructor(host: () => ToolHost) {
    super('keep-alive');
    this.host = host;
  }

  /** Start ticking now. The same job ID replaces any pending one, so this is idempotent. */
  async watch(): Promise<void> {
    await this.lifecycle.jobs.push({ id: JOB, fn: JOB, time: Date.now(), singleflight: true });
  }

  async onJob(): Promise<LifecycleJobOutcome> {
    return (await keepAliveTick(this.host())) ? this.later() : undefined;
  }

  // An unreachable provider or catalog must not end the job; Lifecycle would otherwise complete it.
  onJobError(): LifecycleJobOutcome {
    return this.later();
  }

  private later(): LifecycleJobOutcome {
    return { rescheduleAt: Date.now() + workspaceSettings(this.host().env).keepAliveMs };
  }
}
