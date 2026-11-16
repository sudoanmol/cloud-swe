/**
 * Path: server/src/polling-job.ts
 * Used by: server/src/sandbox/{command-lifecycle,host}.ts, server/src/sessions/{keep-alive,summary,thread}.ts.
 * Purpose: A durable job that repeats a step until the step says it is finished. It lives in the Thread's own alarm queue, next to PiHarness's wake job, so it survives a restart.
 */

import { LifecycleCapability, type LifecycleJobOutcome } from 'agents/lifecycle';

export class PollingJob extends LifecycleCapability {
  private readonly job: string;
  private readonly step: () => Promise<boolean>;
  private readonly everyMs: () => number;
  private readonly firstAfterMs: number | undefined;

  /** `step` returns whether to run again after `everyMs`. The first run waits `firstAfterMs` (`everyMs` by default). */
  constructor(options: {
    capability: string;
    job: string;
    step: () => Promise<boolean>;
    everyMs: () => number;
    firstAfterMs?: number;
  }) {
    super(options.capability);
    this.job = options.job;
    this.step = options.step;
    this.everyMs = options.everyMs;
    this.firstAfterMs = options.firstAfterMs;
  }

  /** Pushing the same ID replaces the pending job, so this is idempotent. */
  async watch(): Promise<void> {
    const time = Date.now() + (this.firstAfterMs ?? this.everyMs());
    await this.lifecycle.jobs.push({ id: this.job, fn: this.job, time, singleflight: true });
  }

  async onJob(): Promise<LifecycleJobOutcome> {
    return (await this.step()) ? this.later() : undefined;
  }

  // An unreachable sandbox, provider or catalog must not end the job; Lifecycle would otherwise complete it.
  onJobError(): LifecycleJobOutcome {
    return this.later();
  }

  private later(): LifecycleJobOutcome {
    return { rescheduleAt: Date.now() + this.everyMs() };
  }
}
