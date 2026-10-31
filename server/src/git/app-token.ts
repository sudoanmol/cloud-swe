/**
 * Path: server/src/git/app-token.ts
 * Used by: server/src/credentials/store.ts.
 * Purpose: Signs GitHub App JWTs and mints installation tokens limited to one repository.
 */
import { importPKCS8, SignJWT } from 'jose';

import type { Env } from '../env.ts';
import { GitHubInstallation, GitHubInstallationToken } from './github-schemas.ts';
import { GitHubError, githubJson } from './github.ts';

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
