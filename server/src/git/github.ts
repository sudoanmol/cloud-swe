import type { GitIdentity } from '@cloud-swe/protocol/credentials';
import { GitSha } from '@cloud-swe/protocol/git';
import type { GithubProfile } from 'better-auth/social-providers';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

import type { Env } from '../env.ts';

const API = 'https://api.github.com';

/** status 0 means the request never got an answer, so its effect is unknown. */
export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function github(
  token: string | undefined,
  method: Method,
  path: string,
  body?: Json,
  accept = 'application/vnd.github+json',
): Promise<Response> {
  const headers = new Headers({
    Accept: accept,
    'User-Agent': 'cloud-swe',
    'X-GitHub-Api-Version': '2022-11-28',
  });

  if (token) headers.set('Authorization', 'Bearer ' + token);

  const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) };

  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  }

  try {
    return await fetch(API + path, init);
  } catch {
    throw new GitHubError(0, 'GitHub request failed');
  }
}

/** Parses a successful JSON response with the given schema. Upstream error text is never surfaced. */
export async function githubJson<S extends z.ZodType>(
  schema: S,
  token: string | undefined,
  method: Method,
  path: string,
  body?: Json,
): Promise<z.output<S>> {
  const response = await github(token, method, path, body);

  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubError(response.status, `GitHub returned ${response.status}`);
  }

  const parsed = schema.safeParse(await response.json().catch(() => null));

  if (!parsed.success) throw new GitHubError(response.status, 'Unexpected GitHub response');

  return parsed.data;
}

const GitHubUser = z.object({
  id: z.number().int(),
  login: z.string().min(1),
  name: z.string().nullable(),
});

const GitHubInstallation = z.object({ id: z.number().int() });

const GitHubInstallationToken = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });

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

type AppEnv = Pick<Env, 'GITHUB_APP_CLIENT_ID' | 'GITHUB_APP_PRIVATE_KEY'>;

async function appJwt(clientId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // GitHub allows ten minutes at most; the backdated start covers clock drift.
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(clientId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(await importPKCS8(privateKey, 'RS256'));
}

/** A token for this repo, or undefined when the app is absent or not installed on it (public repos then go anonymously). */
export async function mintRepoToken(env: AppEnv, owner: string, repo: string) {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_PRIVATE_KEY) return undefined;
  const jwt = await appJwt(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_PRIVATE_KEY);
  let installation: number;

  try {
    ({ id: installation } = await githubJson(GitHubInstallation, jwt, 'GET', `/repos/${owner}/${repo}/installation`));
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return undefined;

    throw error;
  }

  return githubJson(GitHubInstallationToken, jwt, 'POST', `/app/installations/${installation}/access_tokens`, {
    repositories: [repo],
  });
}

const Profile = z.custom<GithubProfile>((value) => GitHubUser.safeParse(value).success);

export const githubProfile = (userToken: string) => githubJson(Profile, userToken, 'GET', '/user');

/** Commits always use the noreply address, so a private email never reaches a repository or sandbox. */
export function gitIdentity(profile: GithubProfile): GitIdentity {
  return {
    login: profile.login,
    name: profile.name?.trim() || profile.login,
    email: `${profile.id}+${profile.login}@users.noreply.github.com`,
  };
}
