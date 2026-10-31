/**
 * Path: server/src/git/repo-tools.ts
 * Used by: server/src/git/tools.ts.
 * Purpose: The git_clone and git_set_base_repo tools: register a repo in Thread storage, then clone it in the sandbox through the command path.
 */
import { BranchName, defaultRepoPath, RepoPath, RepoUrl } from '@cloud-swe/protocol/git';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';

import { executeCommand } from '../tools/commands.ts';
import { type ToolHost, toolWorkspace } from '../tools/host.ts';
import { remoteFileInfo } from '../tools/remote.ts';
import { ensureGitAccess, gitConfigPath } from './access.ts';
import { cloneScript } from './clone.ts';
import { registerRepo, setBaseRepo, unregisterRepo } from './repos.ts';
import { text } from './tool-support.ts';

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

      const identity = await host.env.CREDENTIALS.get(host.env.CREDENTIALS.idFromName('personal')).githubIdentity();
      const root = (await remoteFileInfo(host.env, workspace, '.', AbortSignal.timeout(5000))).path;
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
