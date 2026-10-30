/**
 * Path: server/src/tools/keep-alive.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: A durable job that keeps the sandbox alive while a run is active and shortens its life once the run ends.
 */
import { LifecycleCapability, type LifecycleJobOutcome } from 'agents/lifecycle';

import { requireSession } from '../sessions/thread-store';
import { workspaceSettings } from '../workspaces/settings';
import { commandOperations } from './command-records';
import { endCommandsOfStoppedSandbox } from './command-state';
import type { ToolHost } from './host';

const JOB = 'keep-alive';

/** A run is active while Pi works on a submission or a command is still open. */
async function runActive(host: ToolHost): Promise<boolean> {
  return (await host.harness.session().busy()) || (await commandOperations(host)).length > 0;
}

/**
 * One keep-alive step; returns whether to run again.
 *
 * Boat stops a sandbox at its auto-stop deadline whatever it is doing, so an active run pushes the deadline out. Once
 * the run ends, one final renewal shortens it to a few minutes so the sandbox stops soon and frees its slot. A failed
 * final renewal is retried by the same job; Boat's existing deadline is the fallback.
 */
async function keepAliveTick(host: ToolHost): Promise<boolean> {
  const session = await requireSession(host.storage);
  const active = await runActive(host);

  const state = await host.env.CATALOG.get(host.env.CATALOG.idFromName('personal')).keepAlive(
    session.id,
    session.workspace.id,
    active ? 'active' : 'finished',
  );

  if (state === 'stopped' || state === 'deleted') {
    // The sandbox is gone from under any command, and there is nothing left to keep alive.
    await endCommandsOfStoppedSandbox(host);

    return false;
  }

  // Additional per-tick work belongs here, while a run is active: add the call below.
  // (Git token refresh is wired in at this point.)

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

  // An unreachable Boat or catalog must not end the job; Lifecycle would otherwise complete it.
  onJobError(): LifecycleJobOutcome {
    return this.later();
  }

  private later(): LifecycleJobOutcome {
    return { rescheduleAt: Date.now() + workspaceSettings(this.host().env).keepAliveMs };
  }
}
