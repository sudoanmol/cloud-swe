/**
 * Path: server/src/git/identity.ts
 * Used by: server/src/git/credential-routes.ts.
 * Purpose: Resolves the Git author identity from the GitHub account behind a PAT, never inventing one.
 */
import type { GitIdentity } from '@cloud-swe/protocol/credentials';

import { GitHubError, githubJson } from './github';
import { GitHubEmails, GitHubUser } from './github-schemas';

/** Without the Email addresses permission GitHub answers 403/404 and the noreply address is used. */
async function primaryEmail(token: string): Promise<string | undefined> {
  try {
    const emails = await githubJson(GitHubEmails, token, 'GET', '/user/emails');

    return emails.find((entry) => entry.primary && entry.verified)?.email;
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return undefined;

    throw error;
  }
}

/** `GET /user`, then the primary verified address when the token may read emails, else the noreply address. */
export async function resolveIdentity(token: string): Promise<GitIdentity> {
  const user = await githubJson(GitHubUser, token, 'GET', '/user');

  return {
    login: user.login,
    name: user.name?.trim() || user.login,
    email: (await primaryEmail(token)) ?? `${user.id}+${user.login}@users.noreply.github.com`,
  };
}
