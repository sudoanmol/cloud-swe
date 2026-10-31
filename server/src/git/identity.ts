/**
 * Path: server/src/git/identity.ts
 * Used by: server/src/auth.ts.
 * Purpose: Reads the signed-in GitHub account and the Git author identity it gives, never inventing one.
 */
import type { GitIdentity } from '@cloud-swe/protocol/credentials';
import type { GithubProfile } from 'better-auth/social-providers';
import { z } from 'zod';

import { GitHubUser } from './github-schemas.ts';
import { githubJson } from './github.ts';

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
