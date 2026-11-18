/**
 * Path: server/src/sessions/cut-requests.ts
 * Used by: server/src/sessions/conversations.ts.
 * Purpose: What a rewind does to the approvals, questions and secret requests filed in the part of the conversation it cuts.
 */

import { dropCutApprovals } from '../git/approvals.ts';
import type { KvDeleter, KvLister, KvReader, KvWriter } from '../storage.ts';
import { dropCutQuestions } from '../tools/questions.ts';
import { dropCutSecretRequests } from '../tools/secret-requests.ts';

/**
 * Called inside the rewind's transaction. `before` is the entry the rewind cut before: a request filed when the
 * conversation's newest entry was that one or a later one was asked in the part that is gone. One still waiting on the
 * user is removed; one already decided stays, and its outcome, if not yet sent, never reaches the agent.
 */
export async function dropCutRequests(
  storage: KvReader & KvWriter & KvLister & KvDeleter,
  before: number,
): Promise<void> {
  await dropCutApprovals(storage, before);
  await dropCutQuestions(storage, before);
  await dropCutSecretRequests(storage, before);
}
