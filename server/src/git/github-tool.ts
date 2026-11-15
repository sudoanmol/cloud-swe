/**
 * Path: server/src/git/github-tool.ts
 * Used by: server/src/git/{approval-tools,pull-requests}.ts.
 * Purpose: What every GitHub tool shares: the repo argument, registered-repo resolution, the installation token lookup and failure results that name nothing GitHub said.
 */

import { GitHubRepoRef, repoParts } from '@cloud-swe/protocol/git';
import { Type } from '@earendil-works/pi-ai';

import { credentialsStub } from '../env.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { text } from '../tool-result.ts';
import { GitHubError } from './github.ts';
import { isRegisteredGitHub, readRepos } from './repos.ts';

export type RepoTarget = { owner: string; repo: string; slug: string; url: string };

type Result = ReturnType<typeof text>;

export const repoArg = Type.Optional(
  Type.String({ description: 'owner/repo of a repository cloned in this session; defaults to the base repository' }),
);

export async function resolveRepo(
  host: ToolHost,
  argument: string | undefined,
): Promise<{ ok: true; target: RepoTarget } | { ok: false; error: string }> {
  let reference = argument;

  if (reference === undefined) {
    reference = (await readRepos(host.storage)).find((repo) => repo.base)?.url;

    if (reference === undefined) return { ok: false, error: 'No repo given and the session has no base repository' };
  }

  const url = GitHubRepoRef.safeParse(reference);
  const parts = url.success ? repoParts(url.data) : undefined;

  if (!url.success || parts?.kind !== 'github')
    return { ok: false, error: 'Repository must be owner/repo or a github.com URL' };

  if (!(await isRegisteredGitHub(host.storage, parts.owner, parts.repo))) {
    return { ok: false, error: `${url.data} is not registered for this session; clone it with git_clone first` };
  }

  return {
    ok: true,
    target: { owner: parts.owner, repo: parts.repo, slug: `${parts.owner}/${parts.repo}`, url: url.data },
  };
}

/**
 * Runs `run` with the repo's installation token, which stays in this Worker call and is never put in a result or
 * stored. Any failure becomes a result that names the status and nothing GitHub said.
 */
export async function withToken(
  host: ToolHost,
  target: RepoTarget,
  run: (target: RepoTarget, token: string) => Promise<Result>,
): Promise<Result> {
  try {
    const token = await credentialsStub(host.env).githubToken(target.owner, target.repo);

    if (!token) return text('The GitHub App is not installed on this repository; ask the user to install it', true);

    return await run(target, token);
  } catch (error) {
    return text(
      error instanceof GitHubError
        ? `GitHub request failed (${error.status === 0 ? 'no response' : 'HTTP ' + error.status})`
        : 'GitHub request failed',
      true,
    );
  }
}

/** Resolves the registered repo, then runs `run` with its token. */
export async function guarded(
  host: ToolHost,
  repo: string | undefined,
  run: (target: RepoTarget, token: string) => Promise<Result>,
): Promise<Result> {
  const resolved = await resolveRepo(host, repo);

  if (!resolved.ok) return text(resolved.error, true);

  return withToken(host, resolved.target, run);
}
