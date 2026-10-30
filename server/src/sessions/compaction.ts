/**
 * Path: server/src/sessions/compaction.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Projects Pi's live compaction task and newest compaction failure onto the session, with fixed safe messages only.
 */
import type { Session } from '@cloud-swe/protocol';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { failureFromDetail } from './model-failure.ts';

export async function compactionState(harness: PiHarness): Promise<Pick<Session, 'compaction' | 'compactionFailure'>> {
  const pi = await harness.pi();
  const root = await pi.root(BG);

  // A document draft does not outlive its transaction, so copy out plain values.
  const live = await pi.commit(async (tx) => {
    const doc = await tx.doc(LiveDoc, root.id);
    const status = doc.compactions?.[0];
    const failure = doc.compactionFailure;

    return {
      status: status && {
        reason: status.reason,
        blocking: status.blocking,
        attempt: status.attempt,
        retryAt: status.retry?.at,
      },
      failure: failure && { reason: failure.reason, error: failure.error },
    };
  }, BG);

  const compaction: Session['compaction'] = live.status
    ? { reason: live.status.reason, blocking: live.status.blocking, attempt: live.status.attempt }
    : null;

  if (compaction && live.status?.retryAt !== undefined)
    compaction.nextAttemptAt = new Date(live.status.retryAt).toISOString();

  return {
    compaction,
    compactionFailure: live.failure ? { reason: live.failure.reason, ...failureFromDetail(live.failure.error) } : null,
  };
}
