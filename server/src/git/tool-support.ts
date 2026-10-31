/**
 * Path: server/src/git/tool-support.ts
 * Used by: server/src/git/{repo-tools,pull-request-tools,approval-tools}.ts.
 * Purpose: Shared pieces of the GitHub tools: result text, registered-repo resolution and the server-side installation token lookup.
 */
import { GitHubRepoRef, repoParts } from '@cloud-swe/protocol/git';

import type { ToolHost } from '../tools/host';
import { GitHubError } from './github';
import { isRegisteredGitHub, readRepos } from './repos';

export const text = (message: string, isError = false) => ({
  output: [{ type: 'text' as const, text: message }],
  isError,
});

export type RepoTarget = { owner: string; repo: string; slug: string; url: string };

export type Resolved = { ok: true; target: RepoTarget } | { ok: false; error: string };

/** The repo argument, or the base repo when omitted. It must be registered for this session. */
export async function resolveRepo(host: ToolHost, argument: string | undefined): Promise<Resolved> {
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

export const APP_NOT_INSTALLED = 'The GitHub App is not installed on this repository; ask the user to install it';

/** The installation token stays in this Worker call; it is never put in a tool result or stored. */
export function githubToken(host: ToolHost, target: RepoTarget): Promise<string | undefined> {
  return host.env.CREDENTIALS.get(host.env.CREDENTIALS.idFromName('personal')).githubToken(target.owner, target.repo);
}

/** A tool result for a GitHub failure that names the status and nothing GitHub said. */
export function githubFailure(error: Error): ReturnType<typeof text> {
  return text(
    error instanceof GitHubError
      ? `GitHub request failed (${error.status === 0 ? 'no response' : 'HTTP ' + error.status})`
      : 'GitHub request failed',
    true,
  );
}
