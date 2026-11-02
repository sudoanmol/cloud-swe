/**
 * Path: server/src/sessions/delivery.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: The durable job that delivers server-written follow-ups (approval results, question answers) until each is admitted.
 */

import { LifecycleCapability, type LifecycleJobOutcome } from 'agents/lifecycle';

const JOB = 'follow-up-delivery';
const RETRY_MS = 15_000;

/**
 * Delivery is refused while the session is settling or has no model, and can fail when a sandbox will not resume.
 * The job lives in the Thread's own alarm queue, so a refusal or a restart does not lose what the agent is owed.
 * `deliver` sends everything still owed and returns whether any remains.
 */
export class FollowUpDelivery extends LifecycleCapability {
  readonly deliver: () => Promise<boolean>;

  constructor(deliver: () => Promise<boolean>) {
    super('follow-up-delivery');
    this.deliver = deliver;
  }

  /** Check back soon. Pushing the same ID replaces the pending job, so this is idempotent. */
  async watch(): Promise<void> {
    await this.lifecycle.jobs.push({ id: JOB, fn: JOB, time: Date.now() + RETRY_MS, singleflight: true });
  }

  async onJob(): Promise<LifecycleJobOutcome> {
    return (await this.deliver()) ? this.later() : undefined;
  }

  // An unreachable catalog or sandbox must not end the job; Lifecycle would otherwise complete it.
  onJobError(): LifecycleJobOutcome {
    return this.later();
  }

  private later(): LifecycleJobOutcome {
    return { rescheduleAt: Date.now() + RETRY_MS };
  }
}
