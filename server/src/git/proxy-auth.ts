/**
 * Path: server/src/git/proxy-auth.ts
 * Used by: server/src/sessions/thread.ts (RPC from the proxy route).
 * Purpose: Decides whether a capability token may fetch or push a repo: valid for this session and the repo is registered.
 */
import { tokenValid } from './capability.ts';
import type { KvReader } from './kv.ts';
import { isRegisteredGitHub } from './repos.ts';

export type GitAuthorization = 'ok' | 'unauthorized' | 'forbidden';

export async function gitAuthorization(
  storage: KvReader,
  token: string,
  owner: string,
  repo: string,
): Promise<GitAuthorization> {
  if (!(await tokenValid(storage, token))) return 'unauthorized';

  return (await isRegisteredGitHub(storage, owner.toLowerCase(), repo.toLowerCase())) ? 'ok' : 'forbidden';
}
