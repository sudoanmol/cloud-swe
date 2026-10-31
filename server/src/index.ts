/**
 * Path: server/src/index.ts
 * Used by: wrangler.jsonc (Worker entry point).
 * Purpose: Body limits and sign-in, then routes credentials to their DO and every session route to SessionCatalog.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { authRoutes, requireSignIn } from './auth';
import { credentialRoutes } from './credentials/routes';
import type { Env } from './env';
import { gitProxyRoutes } from './git/proxy';
import { apiError, handleError } from './http';

export { Credentials } from './credentials/store';

export { SessionCatalog, Thread } from './sessions';

const app = new Hono<{ Bindings: Env }>();

app.onError(handleError);

// Sandboxes carry a per-session capability token, not a signed-in session, and push packs larger than the body limit.
gitProxyRoutes(app);

app.use('*', bodyLimit({ maxSize: 128 * 1024, onError: () => apiError('request_too_large') }));

authRoutes(app);

app.use('*', requireSignIn);

credentialRoutes(app);

app.all('/v1/sessions/*', (c) => c.env.CATALOG.get(c.env.CATALOG.idFromName('personal')).fetch(c.req.raw));

app.all('/v1/sessions', (c) => c.env.CATALOG.get(c.env.CATALOG.idFromName('personal')).fetch(c.req.raw));

app.notFound(() => apiError('not_found'));

export default app;
