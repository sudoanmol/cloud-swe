/**
 * Path: server/src/git/credential-routes.ts
 * Used by: server/src/index.ts.
 * Purpose: Write-only GitHub PAT routes: validates the token against GitHub, stores it in the Credentials DO and returns metadata only.
 *
 * Required fine-grained permissions on the selected repositories: Contents read/write, Pull requests read/write,
 * Metadata read. Account permission: Email addresses read (otherwise the noreply address is used). Workflows
 * write only if the agent must change `.github/workflows`.
 */
import { SetGitHubCredentialRequest } from '@cloud-swe/protocol/credentials';
import type { Hono } from 'hono';

import type { Env } from '../env';
import { apiError } from '../http';
import { GitHubError } from './github';
import { resolveIdentity } from './identity';

export function githubCredentialRoutes(app: Hono<{ Bindings: Env }>) {
  app.on(['GET', 'PUT', 'DELETE'], '/v1/credentials/github', async (c) => {
    c.header('Cache-Control', 'no-store');
    const store = c.env.CREDENTIALS.get(c.env.CREDENTIALS.idFromName('personal'));

    if (c.req.method === 'GET') return c.json(await store.githubStatus());

    if (c.req.method === 'DELETE') return c.json(await store.deleteGitHub());

    const parsed = SetGitHubCredentialRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid GitHub credential');

    try {
      const identity = await resolveIdentity(parsed.data.token);

      return c.json(await store.setGitHub(parsed.data.token, identity));
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 401 || error.status === 403)) {
        return apiError(400, 'invalid_request', 'GitHub rejected the token');
      }

      return apiError(503, 'unavailable', 'Could not verify the token with GitHub');
    }
  });
}
