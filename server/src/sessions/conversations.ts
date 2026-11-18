/**
 * Path: server/src/sessions/conversations.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Going back in a conversation: forks the active conversation just above an entry and moves the session to the fork, once per operation ID.
 */

import type { RewindReceipt, RewindRequest, Session } from '@cloud-swe/protocol';

import { failure, type Result } from '../errors.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { dropCutRequests } from './cut-requests.ts';

/** Called under the Thread's admission gate, with the session as it is now. */
export async function rewind(
  _host: ToolHost,
  _session: Session,
  _conversationId: string,
  _request: RewindRequest,
): Promise<Result<RewindReceipt>> {
  void dropCutRequests;

  return failure('internal_error');
}
