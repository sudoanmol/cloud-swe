/**
 * Path: protocol/src/git.ts
 * Used by: protocol/src/{index,storage,credentials}.ts, server/src/git.
 * Purpose: Repository URL validation, session repo inventory, GitHub approvals and PR-tool bounds. Standalone so index.ts can import it.
 */
import { z } from 'zod';

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}$/;

const URL_PATH = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

export type RepoParts = { kind: 'github'; owner: string; repo: string } | { kind: 'other' };

/**
 * Canonical https repository URL, or undefined. GitHub becomes `https://github.com/owner/repo` in lower case,
 * because GitHub names are case-insensitive. No ssh, credentials, ports, queries or fragments.
 */
export function canonicalRepoUrl(input: string): string | undefined {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    return undefined;
  }

  const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  const segments = path.split('/').slice(1);

  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;

  if (url.hostname === 'github.com') {
    const [owner, repo, ...rest] = segments;

    if (rest.length > 0 || !owner || !repo || !GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo)) return undefined;

    return `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }

  if (!HOST.test(url.hostname) || !URL_PATH.test(path)) return undefined;

  return `https://${url.hostname}${path}`;
}

/** Splits a canonical URL produced by canonicalRepoUrl. */
export function repoParts(canonical: string): RepoParts {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(canonical);

  return match?.[1] && match[2] ? { kind: 'github', owner: match[1], repo: match[2] } : { kind: 'other' };
}

export const RepoUrl = z
  .string()
  .max(2048)
  .transform((input, ctx) => {
    const canonical = canonicalRepoUrl(input);

    if (canonical === undefined) ctx.addIssue('Repository URL must be a plain https URL without credentials');

    return canonical ?? '';
  })
  .pipe(z.string().min(1));

/** Owner/repo shorthand or a GitHub URL, always canonical GitHub. For tools that only talk to the GitHub API. */
export const GitHubRepoRef = z
  .string()
  .max(2048)
  .transform((input, ctx) => {
    const canonical = canonicalRepoUrl(/^[^/:]+\/[^/:]+$/.test(input) ? `https://github.com/${input}` : input);

    if (canonical === undefined || repoParts(canonical).kind !== 'github') {
      ctx.addIssue('Repository must be owner/repo or a github.com URL');
    }

    return canonical ?? '';
  })
  .pipe(z.string().min(1));

// Relative, no dot segments, no leading dash, so it is safe as one shell word and cannot leave the workspace.
export const RepoPath = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/)
  .refine((path) => !path.split('/').includes('..'));

export const BranchName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)
  .refine((name) => !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock'));

export const Repo = z.strictObject({ url: RepoUrl, path: RepoPath, base: z.boolean() });

export type Repo = z.infer<typeof Repo>;

export const InitialRepo = z.strictObject({ url: RepoUrl, branch: BranchName.optional() });

export const GitSha = z.string().regex(/^[0-9a-f]{40}$/);

const approvalFields = {
  id: z.uuid(),
  repo: GitHubRepoRef,
  state: z.enum(['pending', 'rejected', 'executing', 'succeeded', 'failed', 'unknown']),
  result: z.string().max(2000).optional(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().optional(),
};

// `expected` is the lease: the target branch or PR head at request time, checked again at execution.
export const Approval = z.discriminatedUnion('kind', [
  z.strictObject({
    ...approvalFields,
    kind: z.literal('ref_update'),
    sha: GitSha,
    targetBranch: BranchName,
    force: z.boolean(),
    expected: GitSha.nullable(),
  }),
  z.strictObject({
    ...approvalFields,
    kind: z.literal('pr_merge'),
    number: z.number().int().positive(),
    method: z.enum(['merge', 'squash', 'rebase']),
    expected: GitSha,
  }),
]);

export type Approval = z.infer<typeof Approval>;

export const DecideApprovalRequest = z.strictObject({ decision: z.enum(['approve', 'reject']) });

export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequest>;

export const ApprovalParams = z.strictObject({ sessionId: z.uuid(), approvalId: z.uuid() });
