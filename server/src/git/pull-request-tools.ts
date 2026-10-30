/**
 * Path: server/src/git/pull-request-tools.ts
 * Used by: server/src/git/tools.ts.
 * Purpose: The free GitHub PR tools (create, update, close, reopen, comment, read). The PAT stays in the Worker; replays create no duplicate PR or comment.
 */
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';

import { requireSession } from '../sessions/thread-store';
import type { ToolHost } from '../tools/host';
import { GitHubError, github, githubJson } from './github';
import { GitHubCheckRuns, GitHubComment, GitHubComments, GitHubPull, GitHubPulls } from './github-schemas';
import { githubFailure, githubToken, type RepoTarget, resolveRepo, text } from './tool-support';

const MAX_OUTPUT = 20_000;

const bounded = (value: string) =>
  value.length > MAX_OUTPUT ? value.slice(0, MAX_OUTPUT) + '\n[output truncated]' : value;

const repoArg = Type.Optional(
  Type.String({ description: 'owner/repo of a repository cloned in this session; defaults to the base repository' }),
);

const pullLine = (pull: { number: number; title: string; state: string; html_url: string }) =>
  `#${pull.number} [${pull.state}] ${pull.title} ${pull.html_url}`;

type Guarded = (target: RepoTarget, token: string) => Promise<ReturnType<typeof text>>;

/** Resolves the registered repo and the PAT, and reports GitHub failures without GitHub's own text. */
async function guarded(host: ToolHost, repo: string | undefined, run: Guarded): Promise<ReturnType<typeof text>> {
  const resolved = await resolveRepo(host, repo);

  if (!resolved.ok) return text(resolved.error, true);
  const target = resolved.target;

  const token = await githubToken(host);

  if (!token) return text('No GitHub token is configured; the user must set one', true);

  try {
    return await run(target, token);
  } catch (error) {
    return githubFailure(error instanceof Error ? error : new Error('unknown'));
  }
}

export function pullRequestTools(host: ToolHost): ToolRegistration[] {
  async function openPullFor(target: RepoTarget, token: string, branch: string, base: string) {
    const head = `${target.owner}:${branch}`;

    const pulls = await githubJson(
      GitHubPulls,
      token,
      'GET',
      `/repos/${target.slug}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(base)}`,
    );

    return pulls[0];
  }

  const create = defineTool({
    name: 'github_pr_create',
    description:
      "Open a pull request from this session's branch (cloud-swe/<sessionId>, which you must have pushed) into a base branch. " +
      'Returns the existing PR if one is already open for that branch and base.',
    parameters: Type.Object({
      repo: repoArg,
      base: Type.String({ description: 'Branch to merge into, e.g. main' }),
      title: Type.String(),
      body: Type.Optional(Type.String()),
      draft: Type.Optional(Type.Boolean()),
    }),
    // Creation looks up the open PR before and after any failure, so a replay finds the first attempt.
    replay: 'safe',
    execute: (args) =>
      guarded(host, args.repo, async (target, token) => {
        const branch = `cloud-swe/${(await requireSession(host.storage)).id}`;
        const existing = await openPullFor(target, token, branch, args.base);

        if (existing) return text(`Already open: ${pullLine(existing)}`);

        try {
          const pull = await githubJson(GitHubPull, token, 'POST', `/repos/${target.slug}/pulls`, {
            title: args.title,
            head: branch,
            base: args.base,
            body: args.body ?? '',
            draft: args.draft ?? false,
          });

          return text(`Opened ${pullLine(pull)}`);
        } catch (error) {
          // A 422 or a lost response may still have created the PR.
          const created = await openPullFor(target, token, branch, args.base).catch(() => undefined);

          if (created) return text(`Opened ${pullLine(created)}`);

          throw error;
        }
      }),
  });

  const update = defineTool({
    name: 'github_pr_update',
    description: 'Edit the title, body or base branch of a pull request.',
    parameters: Type.Object({
      repo: repoArg,
      number: Type.Integer({ minimum: 1 }),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      base: Type.Optional(Type.String()),
    }),
    replay: 'safe',
    execute: (args) =>
      guarded(host, args.repo, async (target, token) => {
        const changes: Record<string, string> = {};

        if (args.title !== undefined) changes.title = args.title;

        if (args.body !== undefined) changes.body = args.body;

        if (args.base !== undefined) changes.base = args.base;

        return text(
          `Updated ${pullLine(await githubJson(GitHubPull, token, 'PATCH', `/repos/${target.slug}/pulls/${args.number}`, changes))}`,
        );
      }),
  });

  const setState = (name: 'github_pr_close' | 'github_pr_reopen', state: 'closed' | 'open', description: string) =>
    defineTool({
      name,
      description,
      parameters: Type.Object({ repo: repoArg, number: Type.Integer({ minimum: 1 }) }),
      replay: 'safe',
      execute: (args) =>
        guarded(host, args.repo, async (target, token) =>
          text(
            pullLine(
              await githubJson(GitHubPull, token, 'PATCH', `/repos/${target.slug}/pulls/${args.number}`, { state }),
            ),
          ),
        ),
    });

  const comment = defineTool({
    name: 'github_pr_comment',
    description: 'Comment on a pull request.',
    parameters: Type.Object({ repo: repoArg, number: Type.Integer({ minimum: 1 }), body: Type.String() }),
    // The call ID is embedded in the comment and searched for first, so a replay posts nothing twice.
    replay: 'safe',
    execute: (args, api) =>
      guarded(host, args.repo, async (target, token) => {
        const marker = `<!-- cloud-swe:${api.callId} -->`;
        const path = `/repos/${target.slug}/issues/${args.number}/comments`;

        for (let page = 1; page <= 10; page++) {
          const comments = await githubJson(GitHubComments, token, 'GET', `${path}?per_page=100&page=${page}`);
          const found = comments.find((entry) => entry.body?.includes(marker));

          if (found) return text(`Commented: ${found.html_url}`);

          if (comments.length < 100) break;
        }

        const posted = await githubJson(GitHubComment, token, 'POST', path, { body: `${args.body}\n\n${marker}` });

        return text(`Commented: ${posted.html_url}`);
      }),
  });

  const read = defineTool({
    name: 'github_pr_read',
    description:
      'Read pull requests: view=list (open PRs), view (one PR), diff, checks (CI status of the head commit) or comments. Output is bounded.',
    parameters: Type.Object({
      repo: repoArg,
      view: Type.Union([
        Type.Literal('list'),
        Type.Literal('view'),
        Type.Literal('diff'),
        Type.Literal('checks'),
        Type.Literal('comments'),
      ]),
      number: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    replay: 'safe',
    execute: (args) =>
      guarded(host, args.repo, async (target, token) => {
        const base = `/repos/${target.slug}`;

        if (args.view === 'list') {
          const pulls = await githubJson(GitHubPulls, token, 'GET', `${base}/pulls?state=open&per_page=30`);

          return text(bounded(pulls.map(pullLine).join('\n') || 'No open pull requests'));
        }

        if (args.number === undefined) return text('number is required for this view', true);
        const pull = await githubJson(GitHubPull, token, 'GET', `${base}/pulls/${args.number}`);

        if (args.view === 'view') {
          return text(bounded(`${pullLine(pull)}\n${pull.head.ref} -> ${pull.base.ref}\n\n${pull.body ?? ''}`));
        }

        if (args.view === 'checks') {
          const runs = await githubJson(GitHubCheckRuns, token, 'GET', `${base}/commits/${pull.head.sha}/check-runs`);

          return text(
            bounded(
              runs.check_runs.map((run) => `${run.name}: ${run.conclusion ?? run.status}`).join('\n') || 'No checks',
            ),
          );
        }

        if (args.view === 'comments') {
          const comments = await githubJson(
            GitHubComments,
            token,
            'GET',
            `${base}/issues/${args.number}/comments?per_page=50`,
          );

          return text(bounded(comments.map((entry) => `- ${entry.body ?? ''}`).join('\n') || 'No comments'));
        }

        const diff = await github(
          token,
          'GET',
          `${base}/pulls/${args.number}`,
          undefined,
          'application/vnd.github.diff',
        );

        if (!diff.ok) throw new GitHubError(diff.status, 'diff failed');

        return text(bounded(await diff.text()));
      }),
  });

  return [
    create,
    update,
    setState('github_pr_close', 'closed', 'Close a pull request without merging it.'),
    setState('github_pr_reopen', 'open', 'Reopen a closed pull request.'),
    comment,
    read,
  ];
}
