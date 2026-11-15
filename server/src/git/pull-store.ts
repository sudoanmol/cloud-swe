/**
 * Path: server/src/git/pull-store.ts
 * Used by: server/src/git/{approvals,pull-requests}.ts, server/src/sessions/thread.ts.
 * Purpose: The last known state of the session's PRs in Thread storage.
 */

import { PullRequest } from '@cloud-swe/protocol/git';

import { type KvLister, type KvReader, type KvWriter, listParsed, readParsed } from '../storage.ts';

const PREFIX = 'pull:';

const LIMIT = 100;

const key = (repo: string, number: number) => `${PREFIX}${repo}#${String(number).padStart(10, '0')}`;

export async function readPull(storage: KvReader, repo: string, number: number): Promise<PullRequest | undefined> {
  return readParsed(storage, key(repo, number), PullRequest);
}

export async function writePull(storage: KvWriter, pull: PullRequest) {
  await storage.put(key(pull.repo, pull.number), PullRequest.parse(pull));
}

export async function listPulls(storage: KvLister): Promise<PullRequest[]> {
  return (await listParsed(storage, PREFIX, PullRequest)).slice(-LIMIT);
}

/** A merge approved here. A PR merged on GitHub directly shows its new state after the next read. */
export async function markPullMerged(storage: KvReader & KvWriter, repo: string, number: number) {
  const known = await readPull(storage, repo, number);

  if (known) await writePull(storage, { ...known, state: 'merged' });
}
