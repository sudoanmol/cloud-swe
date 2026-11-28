/**
 * Path: server/src/git/repos.ts
 * Used by: server/src/git/{access,clone,tools}.ts, server/src/prompts/index.ts, server/src/sessions/{projection,workspace-ready}.ts.
 * Purpose: The session's repository inventory in Thread storage, and the session's short ID that ends its suggested branch names.
 */

import { StoredRepo } from '@cloud-swe/protocol/storage';
import { z } from 'zod';

import { type KvReader, type KvWriter, reading, readParsed } from '../storage.ts';

const KEY = 'repos';

// One row holds the list; each repository in it is a stored record of its own.
export async function readRepos(storage: KvReader): Promise<StoredRepo[]> {
  return (await readParsed(storage, KEY, z.array(reading(StoredRepo)))) ?? [];
}

/**
 * Adds a repo and returns whether it was new. The first becomes the base; re-registering the same URL and path is a
 * no-op, and a different path for a known URL or a taken path is refused.
 */
export async function registerRepo(storage: KvReader & KvWriter, url: string, path: string): Promise<boolean> {
  const repos = await readRepos(storage);
  const known = repos.find((repo) => repo.url === url);

  if (known) {
    if (known.path !== path) throw new Error(`${url} is already checked out at ${known.path}`);

    return false;
  }

  if (repos.some((repo) => repo.path === path)) throw new Error(`Path ${path} is already used by another repo`);
  const next = [...repos, { url, path, base: repos.length === 0 }];

  if (next.length > 50) throw new Error('Too many repositories');
  await storage.put(KEY, StoredRepo.array().parse(next));

  return true;
}

export async function unregisterRepo(storage: KvReader & KvWriter, url: string): Promise<void> {
  const next = (await readRepos(storage)).filter((repo) => repo.url !== url);
  await storage.put(KEY, next);
}

/** Base is context only: it changes no authorization. */
export async function setBaseRepo(storage: KvReader & KvWriter, url: string): Promise<void> {
  const repos = await readRepos(storage);

  if (!repos.some((repo) => repo.url === url)) throw new Error(`${url} is not registered`);
  await storage.put(
    KEY,
    repos.map((repo) => ({ ...repo, base: repo.url === url })),
  );
}

/** The end of the branch name the prompt suggests: `cloud-swe/<slug>-<id>`, with the slug chosen by the agent. */
export const branchSuffix = (sessionId: string) => sessionId.slice(0, 8);
