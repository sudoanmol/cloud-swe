/**
 * Path: server/src/git/repos.ts
 * Used by: server/src/git/{tools,proxy-auth,clone}.ts, server/src/sessions/thread.ts.
 * Purpose: The session's repository inventory in Thread storage. Registration is the authorization to fetch a repo through the proxy.
 */
import { Repo, repoParts } from '@cloud-swe/protocol/git';

import type { KvReader as Reader, KvWriter as Writer } from '../storage.ts';

const KEY = 'repos';

export async function readRepos(storage: Reader): Promise<Repo[]> {
  const raw = await storage.get<unknown>(KEY);

  return raw === undefined ? [] : Repo.array().parse(raw);
}

/**
 * Adds a repo. The first becomes the base unless one exists; re-registering the same URL and path is a no-op,
 * and a different path for a known URL or a taken path is refused.
 */
export async function registerRepo(
  storage: Reader & Writer,
  url: string,
  path: string,
  base = false,
): Promise<{ repos: Repo[]; added: boolean }> {
  const repos = await readRepos(storage);
  const known = repos.find((repo) => repo.url === url);

  if (known) {
    if (known.path !== path) throw new Error(`${url} is already checked out at ${known.path}`);

    return { repos, added: false };
  }

  if (repos.some((repo) => repo.path === path)) throw new Error(`Path ${path} is already used by another repo`);

  const next = [
    ...repos.map((repo) => ({ ...repo, base: base ? false : repo.base })),
    { url, path, base: base || repos.length === 0 },
  ];

  if (next.length > 50) throw new Error('Too many repositories');
  await storage.put(KEY, Repo.array().parse(next));

  return { repos: next, added: true };
}

export async function unregisterRepo(storage: Reader & Writer, url: string): Promise<void> {
  const next = (await readRepos(storage)).filter((repo) => repo.url !== url);
  await storage.put(KEY, next);
}

/** Base is context only: it changes no authorization. */
export async function setBaseRepo(storage: Reader & Writer, url: string): Promise<Repo[]> {
  const repos = await readRepos(storage);

  if (!repos.some((repo) => repo.url === url)) throw new Error(`${url} is not registered`);
  const next = repos.map((repo) => ({ ...repo, base: repo.url === url }));
  await storage.put(KEY, next);

  return next;
}

/** Whether the session may fetch this GitHub repo: it is registered. */
export async function isRegisteredGitHub(storage: Reader, owner: string, name: string): Promise<boolean> {
  return (await readRepos(storage)).some((repo) => {
    const parts = repoParts(repo.url);

    return parts.kind === 'github' && parts.owner === owner && parts.repo === name;
  });
}
