/**
 * Path: server/src/git/approval-tools.ts
 * Used by: server/src/git/tools.ts.
 * Purpose: git_request_ref_update and github_pr_merge: file a durable approval and return at once. Only the user's decision route executes it.
 */
import { Approval, BranchName, GitSha } from '@cloud-swe/protocol/git';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';

import type { ToolHost } from '../tools/host.ts';
import { readApproval, writeApproval } from './approvals.ts';
import { GitHubCommit, GitHubError, githubJson, GitHubPull, GitHubRef } from './github.ts';
import { deterministicUuid } from './ids.ts';
import { APP_NOT_INSTALLED, githubFailure, githubToken, resolveRepo, text } from './tools.ts';

const repoArg = Type.Optional(
  Type.String({ description: 'owner/repo of a repository cloned in this session; defaults to the base repository' }),
);

const filed = (id: string) =>
  `Approval ${id} is pending the user's decision. Keep working on something else, or end your turn: ` +
  `you will receive a message when it is decided.`;

export function approvalTools(host: ToolHost): ToolRegistration[] {
  const refUpdate = defineTool({
    name: 'git_request_ref_update',
    description:
      'Ask the user to move a branch other than your own session branch (for example main), or to force-update one, ' +
      'to a commit that is already on GitHub (usually pushed to your session branch first). It returns immediately; ' +
      'the user decides later and you get the result as a message.',
    parameters: Type.Object({
      repo: repoArg,
      sha: Type.String({ description: '40-character commit SHA, already on GitHub' }),
      targetBranch: Type.String({ description: 'Branch to move, e.g. main' }),
      force: Type.Optional(Type.Boolean({ description: 'Allow a non-fast-forward update' })),
    }),
    // The approval ID derives from the call ID, so a replay finds the record instead of filing another.
    replay: 'safe',
    async execute(args, api) {
      const resolved = await resolveRepo(host, args.repo);

      if (!resolved.ok) return text(resolved.error, true);
      const sha = GitSha.safeParse(args.sha);
      const branch = BranchName.safeParse(args.targetBranch);

      if (!sha.success || !branch.success) return text('Invalid sha or branch name', true);
      const id = await deterministicUuid('approval:' + api.callId);

      if (await readApproval(host.storage, id)) return text(filed(id));
      const token = await githubToken(host, resolved.target).catch((error: Error) => error);

      if (token instanceof Error) return githubFailure(token);

      if (!token) return text(APP_NOT_INSTALLED, true);

      try {
        await githubJson(GitHubCommit, token, 'GET', `/repos/${resolved.target.slug}/git/commits/${sha.data}`);
      } catch {
        return text('That commit is not on GitHub; push it to your session branch first', true);
      }

      let expected: string | null = null;

      try {
        expected = (
          await githubJson(GitHubRef, token, 'GET', `/repos/${resolved.target.slug}/git/ref/heads/${branch.data}`)
        ).object.sha;
      } catch (error) {
        if (!(error instanceof GitHubError && error.status === 404)) {
          return githubFailure(error instanceof Error ? error : new Error('unknown'));
        }
      }

      await writeApproval(host.storage, {
        delivered: false,
        approval: Approval.parse({
          id,
          kind: 'ref_update',
          repo: resolved.target.url,
          state: 'pending',
          sha: sha.data,
          targetBranch: branch.data,
          force: args.force ?? false,
          expected,
          createdAt: new Date().toISOString(),
        }),
      });

      return text(filed(id));
    },
  });

  const merge = defineTool({
    name: 'github_pr_merge',
    description:
      'Ask the user to merge a pull request. It returns immediately; the user decides later and you get the result as a message.',
    parameters: Type.Object({
      repo: repoArg,
      number: Type.Integer({ minimum: 1 }),
      method: Type.Optional(Type.Union([Type.Literal('merge'), Type.Literal('squash'), Type.Literal('rebase')])),
    }),
    replay: 'safe',
    async execute(args, api) {
      const resolved = await resolveRepo(host, args.repo);

      if (!resolved.ok) return text(resolved.error, true);
      const id = await deterministicUuid('approval:' + api.callId);

      if (await readApproval(host.storage, id)) return text(filed(id));
      const token = await githubToken(host, resolved.target).catch((error: Error) => error);

      if (token instanceof Error) return githubFailure(token);

      if (!token) return text(APP_NOT_INSTALLED, true);

      try {
        const pull = await githubJson(GitHubPull, token, 'GET', `/repos/${resolved.target.slug}/pulls/${args.number}`);

        if (pull.state !== 'open') return text(`PR #${args.number} is not open`, true);

        await writeApproval(host.storage, {
          delivered: false,
          approval: Approval.parse({
            id,
            kind: 'pr_merge',
            repo: resolved.target.url,
            state: 'pending',
            number: args.number,
            method: args.method ?? 'squash',
            expected: pull.head.sha,
            baseRef: pull.base.ref,
            createdAt: new Date().toISOString(),
          }),
        });
      } catch (error) {
        return githubFailure(error instanceof Error ? error : new Error('unknown'));
      }

      return text(filed(id));
    },
  });

  return [refUpdate, merge];
}
