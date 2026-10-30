/**
 * Path: server/src/git/pull-records.ts
 * Used by: server/src/git/{pull-request-tools,approval-flow}.ts, server/src/sessions/thread.ts.
 * Purpose: The pull requests this session opened, last known state, so clients can show them without calling GitHub.
 */
import { PullRequest } from '@cloud-swe/protocol/git';

const PREFIX = 'pull:';

const LIMIT = 100;

type Reader = Pick<DurableObjectStorage, 'get' | 'list'>;

type Writer = Pick<DurableObjectStorage, 'put'>;

const key = (repo: string, number: number) => `${PREFIX}${repo}#${String(number).padStart(10, '0')}`;

export async function readPull(storage: Reader, repo: string, number: number): Promise<PullRequest | undefined> {
  const raw = await storage.get<unknown>(key(repo, number));

  return raw === undefined ? undefined : PullRequest.parse(raw);
}

export async function writePull(storage: Writer, pull: PullRequest) {
  await storage.put(key(pull.repo, pull.number), PullRequest.parse(pull));
}

export async function listPulls(storage: Reader): Promise<PullRequest[]> {
  const rows = await storage.list<unknown>({ prefix: PREFIX });

  return [...rows.values()].map((raw) => PullRequest.parse(raw)).slice(-LIMIT);
}

/** A merge approved here. A PR merged on GitHub directly shows its new state after the next read. */
export async function markPullMerged(storage: Reader & Writer, repo: string, number: number) {
  const known = await readPull(storage, repo, number);

  if (known) await writePull(storage, { ...known, state: 'merged' });
}
