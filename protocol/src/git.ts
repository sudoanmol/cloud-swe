/**
 * Path: protocol/src/git.ts
 * Used by: the @cloud-swe/protocol/git package export, protocol/src/{index,storage}.ts.
 * Purpose: Repository URL validation and the session repo inventory. Standalone so index.ts can import it.
 */

import { z } from 'zod';

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}$/;

const URL_PATH = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

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

export const RepoUrl = z
  .string()
  .max(2048)
  .transform((input, ctx) => {
    const canonical = canonicalRepoUrl(input);

    if (canonical === undefined) ctx.addIssue('Repository URL must be a plain https URL without credentials');

    return canonical ?? '';
  })
  .pipe(z.string().min(1));

// Relative, no dot segments, no leading dash, so it is safe as one shell word and cannot leave the workspace.
export const RepoPath = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/)
  .refine((path) => !path.split('/').includes('..'));

/**
 * The directory a repository clones into by default: its last URL segment, without leading dots or dashes
 * (`.github` becomes `github`). Undefined when nothing valid is left, which only a non-GitHub host can cause.
 */
export function defaultRepoPath(url: string): string | undefined {
  const parsed = RepoPath.safeParse((url.split('/').at(-1) ?? '').replace(/^[.-]+/, ''));

  return parsed.success ? parsed.data : undefined;
}

export const BranchName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)
  .refine((name) => !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock'));

export const Repo = z.strictObject({ url: RepoUrl, path: RepoPath, base: z.boolean() });

export type Repo = z.infer<typeof Repo>;

// Checked at the API edge, so a session is never created with a repository it cannot register.
export const InitialRepo = z
  .strictObject({ url: RepoUrl, branch: BranchName.optional() })
  .refine((repo) => defaultRepoPath(repo.url) !== undefined, { message: 'Repository name is not a usable directory' });
