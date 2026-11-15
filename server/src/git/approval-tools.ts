/**
 * Path: server/src/git/approval-tools.ts
 * Used by: server/src/tools/registry.ts.
 * Purpose: git_request_ref_update and github_pr_merge: file a durable approval and return at once. Only the user's decision route executes it.
 */

import { BranchName, GitSha } from '@cloud-swe/protocol/git';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { z } from 'zod';

import { deterministicUuid } from '../ids.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { text } from '../tool-result.ts';
import { fileApproval, readApproval } from './approvals.ts';
import { repoArg, resolveRepo, withToken } from './github-tool.ts';
import { githubJson, GitHubPull, readRef } from './github.ts';

const GitHubCommit = z.object({ sha: GitSha });

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

      return withToken(host, resolved.target, async (target, token) => {
        try {
          await githubJson(GitHubCommit, token, 'GET', `/repos/${target.slug}/git/commits/${sha.data}`);
        } catch {
          return text('That commit is not on GitHub; push it to your session branch first', true);
        }

        const expected = await readRef(token, target.slug, `refs/heads/${branch.data}`);

        await fileApproval(host.storage, {
          id,
          kind: 'ref_update',
          repo: target.url,
          sha: sha.data,
          targetBranch: branch.data,
          force: args.force ?? false,
          expected,
        });

        return text(filed(id));
      });
    },
  });

  const merge = defineTool({
    name: 'github_pr_merge',
    description:
      'Ask the user to merge a pull request, with a merge commit unless the user asked for another method. It returns immediately; the user decides later and you get the result as a message.',
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

      return withToken(host, resolved.target, async (target, token) => {
        const pull = await githubJson(GitHubPull, token, 'GET', `/repos/${target.slug}/pulls/${args.number}`);

        if (pull.state !== 'open') return text(`PR #${args.number} is not open`, true);

        await fileApproval(host.storage, {
          id,
          kind: 'pr_merge',
          repo: target.url,
          number: args.number,
          method: args.method ?? 'merge',
          expected: pull.head.sha,
          baseRef: pull.base.ref,
        });

        return text(filed(id));
      });
    },
  });

  return [refUpdate, merge];
}
