import { BranchName, defaultRepoPath, GitHubRepoRef, repoParts, RepoPath, RepoUrl } from '@cloud-swe/protocol/git';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';

import { credentialsStub } from '../env.ts';
import { executeCommand } from '../tools/commands.ts';
import { type ToolHost, toolWorkspace } from '../tools/host.ts';
import { sandboxRoot } from '../tools/remote.ts';
import { ensureGitAccess, gitConfigPath } from './access.ts';
import { cloneScript } from './clone.ts';
import { GitHubError } from './github.ts';
import { isRegisteredGitHub, readRepos, registerRepo, setBaseRepo, unregisterRepo } from './repos.ts';

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
  return credentialsStub(host.env).githubToken(target.owner, target.repo);
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

const CLONE_TIMEOUT_SECONDS = 600;

const cloneSchema = Type.Object({
  url: Type.String({ description: 'https URL of the repository, e.g. https://github.com/owner/repo' }),
  branch: Type.Optional(Type.String({ description: 'Branch to check out; the default branch if omitted' })),
  path: Type.Optional(Type.String({ description: 'Directory to clone into; defaults to the repository name' })),
});

export function repoTools(host: ToolHost): ToolRegistration[] {
  const clone = defineTool({
    name: 'git_clone',
    description:
      'Clone a public or private GitHub repository, or any public https repository, into the sandbox and register it for this session. ' +
      'GitHub clones, fetches and pushes use the session proxy, so do not configure credentials. ' +
      'You may push only to your own cloud-swe/<slug>-<id> branches; ' +
      'use github_pr_create to open a pull request from one.',
    parameters: cloneSchema,
    // The clone is idempotent: an existing checkout is skipped, and the command reattaches by task.
    replay: 'safe',
    async execute(args, api, context) {
      const url = RepoUrl.safeParse(args.url);
      const branch = args.branch === undefined ? undefined : BranchName.safeParse(args.branch);

      const path = RepoPath.safeParse(args.path ?? (url.success ? defaultRepoPath(url.data) : ''));

      if (!url.success) return text('Invalid repository URL: use a plain https URL without credentials', true);

      if (branch && !branch.success) return text('Invalid branch name', true);

      if (!path.success)
        return text('Invalid path: use a relative path of letters, digits, dot, dash and underscore', true);

      const workspace = await toolWorkspace(host);

      let added: boolean;

      try {
        ({ added } = await host.storage.transaction((tx) => registerRepo(tx, url.data, path.data)));
      } catch (error) {
        return text(error instanceof Error ? error.message : 'Cannot register repository', true);
      }

      try {
        await ensureGitAccess(host);
      } catch {
        return text('Git access is unavailable on this server', true);
      }

      const identity = await credentialsStub(host.env).githubIdentity();
      const root = await sandboxRoot(host.env, workspace);
      let output = '';

      const result = await executeCommand(
        host,
        workspace,
        api,
        cloneScript({
          url: url.data,
          path: path.data,
          branch: branch?.data,
          configPath: await gitConfigPath(host),
          identity,
        }),
        {
          cwd: root,
          timeout: CLONE_TIMEOUT_SECONDS,
          onOutput: (chunk) => {
            output = (output + chunk).slice(-4000);
          },
        },
        context,
      );

      if (!result.ok || result.value.exitCode !== 0) {
        if (added) await host.storage.transaction((tx) => unregisterRepo(tx, url.data));

        return text(`Clone failed${result.ok ? '' : ': ' + result.error.message}\n${output}`, true);
      }

      const note = identity ? '' : ' Nobody has signed in yet, so no git user.name/user.email was configured.';

      return text(`Cloned ${url.data} into ${path.data}.${note}\n${output}`.trim());
    },
  });

  const setBase = defineTool({
    name: 'git_set_base_repo',
    description:
      "Choose which registered repository is the session's base (the default one for pull requests and context). " +
      'This grants no access to other repositories.',
    parameters: Type.Object({ url: Type.String({ description: 'URL of an already cloned repository' }) }),
    replay: 'safe',
    async execute(args) {
      const url = RepoUrl.safeParse(args.url);

      if (!url.success) return text('Invalid repository URL', true);

      try {
        await host.storage.transaction((tx) => setBaseRepo(tx, url.data));
      } catch (error) {
        return text(error instanceof Error ? error.message : 'Cannot change base repository', true);
      }

      return text(`Base repository is now ${url.data}`);
    },
  });

  return [clone, setBase];
}
