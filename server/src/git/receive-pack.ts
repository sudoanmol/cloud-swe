/**
 * Path: server/src/git/receive-pack.ts
 * Used by: server/src/git/{proxy,pull-request-tools}.ts.
 * Purpose: The push policy: one command, to one of the session's own branches. Deleting a ref and creating a tag are refused here and sent to the user.
 */
import { RefName } from '@cloud-swe/protocol/git';

import { isZero, type PushCommand, type PushRequest } from './pktline.ts';

/** The last part of every branch this session may push: `cloud-swe/<slug>-<id>`, with the slug chosen by the agent. */
export const branchSuffix = (sessionId: string) => sessionId.slice(0, 8);

export const isSessionBranch = (branch: string, sessionId: string) =>
  new RegExp(`^cloud-swe/[a-z0-9]+(?:-[a-z0-9]+)*-${branchSuffix(sessionId)}$`).test(branch) && branch.length <= 80;

export type PushDecision = { ok: true; command: PushCommand } | { ok: false; reason: string; blocked?: PushCommand };

/** Pure policy over the parsed command list. The pack itself is never inspected. */
export function checkPush(request: PushRequest, sessionId: string): PushDecision {
  if (request.unsupported) return { ok: false, reason: 'unsupported push request' };

  const [command, ...rest] = request.commands;

  if (!command || rest.length > 0) return { ok: false, reason: 'push exactly one ref' };

  const isTag = command.ref.startsWith('refs/tags/');
  const isDelete = isZero(command.new);

  if (isDelete || isTag) {
    // Moving an existing tag has no approval path.
    if (isTag && !isDelete && !isZero(command.old)) return { ok: false, reason: 'moving a tag is not allowed' };

    const reason = isDelete ? 'deleting a ref needs approval' : 'pushing a tag needs approval';

    return RefName.safeParse(command.ref).success ? { ok: false, reason, blocked: command } : { ok: false, reason };
  }

  if (!command.ref.startsWith('refs/heads/') || !isSessionBranch(command.ref.slice(11), sessionId)) {
    return {
      ok: false,
      reason: `only cloud-swe/<slug>-${branchSuffix(sessionId)} may be pushed; use git_request_ref_update for others`,
    };
  }

  return { ok: true, command };
}
