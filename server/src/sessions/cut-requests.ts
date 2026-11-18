/**
 * Path: server/src/sessions/cut-requests.ts
 * Used by: server/src/sessions/conversations.ts.
 * Purpose: What a rewind does to the approvals, questions and secret requests filed in the part of the conversation it cuts.
 */

import type { KvDeleter, KvLister, KvReader, KvWriter } from '../storage.ts';

/**
 * Called inside the rewind's transaction. `before` is the entry the rewind cut before: a request filed when the
 * conversation's newest entry was that one or a later one was asked in the part that is gone.
 */
export async function dropCutRequests(
  _storage: KvReader & KvWriter & KvLister & KvDeleter,
  _before: number,
): Promise<void> {}
