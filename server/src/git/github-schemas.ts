/**
 * Path: server/src/git/github-schemas.ts
 * Used by: server/src/git/{github,identity,pull-requests,approvals-exec}.ts.
 * Purpose: The parts of GitHub's REST responses this server reads. Anything else GitHub sends is ignored.
 */
import { GitSha } from '@cloud-swe/protocol/git';
import { z } from 'zod';

export const GitHubUser = z.object({
  id: z.number().int(),
  login: z.string().min(1),
  name: z.string().nullable(),
});

export const GitHubInstallation = z.object({ id: z.number().int() });

export const GitHubInstallationToken = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });

export const GitHubRef = z.object({ object: z.object({ sha: GitSha }) });

export const GitHubCommit = z.object({ sha: GitSha });

export const GitHubCompare = z.object({ status: z.string() });

export const GitHubPull = z.object({
  number: z.number().int(),
  html_url: z.string(),
  title: z.string(),
  state: z.string(),
  merged: z.boolean().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  head: z.object({ sha: GitSha, ref: z.string() }),
  base: z.object({ ref: z.string() }),
});

export const GitHubPulls = z.array(GitHubPull);

export const GitHubComment = z.object({ id: z.number().int(), body: z.string().nullable(), html_url: z.string() });

export const GitHubComments = z.array(GitHubComment);

export const GitHubCheckRuns = z.object({
  check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});

export const GitHubMerge = z.object({
  merged: z.boolean(),
  sha: z.string().optional(),
  message: z.string().optional(),
});
