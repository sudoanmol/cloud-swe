/**
 * Path: server/src/git/approval-delivery.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: A durable job that keeps retrying the follow-up message for decided or unknown approvals until the session admits it.
 */
import { LifecycleCapability, type LifecycleJobOutcome } from 'agents/lifecycle';

import { type ApprovalHost, deliverPending } from './approval-flow';

const JOB = 'approval-delivery';
const RETRY_MS = 15_000;

/**
 * Delivery is refused while the session is settling or has no model, and can fail when a sandbox will not resume.
 * The job lives in the Thread's own alarm queue, so a refusal or a restart does not lose the agent's result.
 * It only delivers messages; it never executes or reconciles anything on GitHub.
 */
export class ApprovalDelivery extends LifecycleCapability {
  readonly host: () => ApprovalHost;

  constructor(host: () => ApprovalHost) {
    super('approval-delivery');
    this.host = host;
  }

  /** Check back soon. Pushing the same ID replaces the pending job, so this is idempotent. */
  async watch(): Promise<void> {
    await this.lifecycle.jobs.push({ id: JOB, fn: JOB, time: Date.now() + RETRY_MS, singleflight: true });
  }

  async onJob(): Promise<LifecycleJobOutcome> {
    return (await deliverPending(this.host())) ? this.later() : undefined;
  }

  // An unreachable catalog or sandbox must not end the job; Lifecycle would otherwise complete it.
  onJobError(): LifecycleJobOutcome {
    return this.later();
  }

  private later(): LifecycleJobOutcome {
    return { rescheduleAt: Date.now() + RETRY_MS };
  }
}
