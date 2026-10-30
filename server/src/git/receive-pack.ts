/**
 * Path: server/src/git/receive-pack.ts
 * Used by: server/src/git/proxy.ts.
 * Purpose: The push policy: one command, to the session's own branch, no deletes and no tags.
 */
import { isZero, type PushCommand, type PushRequest } from './pktline.ts';

export const sessionBranch = (sessionId: string) => `refs/heads/cloud-swe/${sessionId}`;

export type PushDecision = { ok: true; command: PushCommand } | { ok: false; reason: string };

/** Pure policy over the parsed command list. The pack itself is never inspected. */
export function checkPush(request: PushRequest, sessionId: string): PushDecision {
  if (request.unsupported) return { ok: false, reason: 'unsupported push request' };

  const [command, ...rest] = request.commands;

  if (!command || rest.length > 0) return { ok: false, reason: 'push exactly one ref' };

  if (command.ref.startsWith('refs/tags/')) return { ok: false, reason: 'pushing tags is not allowed' };

  if (command.ref !== sessionBranch(sessionId)) {
    return {
      ok: false,
      reason: `only ${sessionBranch(sessionId)} may be pushed; use git_request_ref_update for others`,
    };
  }

  if (isZero(command.new)) return { ok: false, reason: 'deleting branches is not allowed' };

  return { ok: true, command };
}
