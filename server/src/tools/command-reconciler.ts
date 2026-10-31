/**
 * Path: server/src/tools/command-reconciler.ts
 * Used by: server/src/sessions/thread.ts, server/src/tools/host.ts.
 * Purpose: A durable job that runs while any command is open, stopping orphans that no live Pi tool call owns.
 */
import { LifecycleCapability, type LifecycleJobOutcome } from 'agents/lifecycle';

import { commandOperations } from './command-records.ts';
import { reconcileCommands } from './command-state.ts';
import type { ToolHost } from './host.ts';

const JOB = 'reconcile';
const EVERY_MS = 5000;

/**
 * Stops commands Pi no longer owns from a durable Lifecycle job, so no read route has to.
 * The job lives in the Thread's own alarm queue next to PiHarness's wake job and survives a restart.
 */
export class CommandReconciler extends LifecycleCapability {
  readonly host: () => ToolHost;

  constructor(host: () => ToolHost) {
    super('command-reconciler');
    this.host = host;
  }

  /** Keep checking while a command is open. Pushing the same ID replaces the job, so this is idempotent. */
  async watch(): Promise<void> {
    await this.lifecycle.jobs.push({ id: JOB, fn: JOB, time: Date.now() + EVERY_MS, singleflight: true });
  }

  async onJob(): Promise<LifecycleJobOutcome> {
    await reconcileCommands(this.host());

    // A running command still owned by Pi stays open, so keep watching until none is.
    return (await commandOperations(this.host())).length > 0 ? this.later() : undefined;
  }

  // An unreachable sandbox or catalog must not end the watch; Lifecycle would otherwise complete the job.
  onJobError(): LifecycleJobOutcome {
    return this.later();
  }

  private later(): LifecycleJobOutcome {
    return { rescheduleAt: Date.now() + EVERY_MS };
  }
}
