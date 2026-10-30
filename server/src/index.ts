/**
 * Path: server/src/index.ts
 * Used by: wrangler.jsonc (Worker entry point).
 * Purpose: Bearer auth and body limits, then routes credentials to their DO and every session route to SessionCatalog.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'hono/utils/buffer';

import { credentialRoutes } from './credentials/routes';
import type { Env } from './env';
import { githubCredentialRoutes } from './git/credential-routes';
import { gitProxyRoutes } from './git/proxy';
import { apiError, handleError } from './http';

export { Credentials } from './credentials/store';

export { SessionCatalog, Thread } from './sessions';

const app = new Hono<{ Bindings: Env }>();

app.onError(handleError);

// Sandboxes carry a per-session capability token, not the API token, and push packs larger than the body limit.
gitProxyRoutes(app);

app.use('*', async (c, next) => {
  if (!c.env.API_TOKEN) return apiError('api_not_configured');
  const authorization = c.req.header('Authorization');

  if (!authorization || !(await timingSafeEqual(authorization, `Bearer ${c.env.API_TOKEN}`))) {
    return apiError('unauthorized');
  }

  await next();
});

app.use('*', bodyLimit({ maxSize: 128 * 1024, onError: () => apiError('request_too_large') }));

credentialRoutes(app);

githubCredentialRoutes(app);

app.all('/v1/sessions/*', (c) => c.env.CATALOG.get(c.env.CATALOG.idFromName('personal')).fetch(c.req.raw));

app.all('/v1/sessions', (c) => c.env.CATALOG.get(c.env.CATALOG.idFromName('personal')).fetch(c.req.raw));

app.notFound(() => apiError('not_found'));

export default app;
