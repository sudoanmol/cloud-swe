/**
 * Path: server/src/sessions/compaction.ts
 * Used by: server/src/sessions/{projection,thread}.ts.
 * Purpose: Starts a conversation's compaction, and projects Pi's live compaction task and newest compaction failure onto the session, with fixed safe messages only.
 */

import type { Session } from '@cloud-swe/protocol';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import type { PiHarness } from 'agents/harness/pi';

import { failure, type Result, success } from '../errors.ts';
import { failureFromDetail } from './failures.ts';
import { requireConversation } from './pi.ts';

/** The conversation's running compaction and its newest compaction failure. */
export async function compactionState(
  harness: PiHarness,
  conversationId: string,
): Promise<Pick<Session, 'compaction' | 'compactionFailure'>> {
  const conversation = await requireConversation(harness, conversationId);

  // A document draft does not outlive its transaction, so copy out plain values.
  const live = await conversation.commit(async (tx) => {
    const doc = await tx.doc(LiveDoc, conversation.id);
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

/** Starts compacting the conversation. Pi summarizes while it keeps working. */
export async function startCompaction(
  harness: PiHarness,
  conversationId: string,
  instructions: string | undefined,
): Promise<Result<null>> {
  if ((await compactionState(harness, conversationId)).compaction) return failure('compaction_running');
  await (await requireConversation(harness, conversationId)).compact(instructions, BG);

  return success(null);
}
