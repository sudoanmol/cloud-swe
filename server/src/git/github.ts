/**
 * Path: server/src/git/github.ts
 * Used by: server/src/git/{identity,credential-routes,force-push,pull-requests,approvals-exec}.ts.
 * Purpose: The only GitHub REST client. Sends the PAT, never logs or returns it, and surfaces failures as GitHubError with a status.
 */
import type { z } from 'zod';

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
