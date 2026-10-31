/**
 * Path: server/src/index.ts
 * Used by: wrangler.jsonc (Worker entry point).
 * Purpose: Body limits and sign-in, then routes credentials to their DO and every session route to SessionCatalog.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { authRoutes, requireSignIn } from './auth.ts';
import { credentialRoutes } from './credentials.ts';
import type { Env } from './env.ts';
import { apiError, handleError } from './errors.ts';
import { gitProxyRoutes } from './git/proxy.ts';

export { Credentials } from './credentials.ts';

export { SessionCatalog } from './sessions/catalog.ts';

export { Thread } from './sessions/thread.ts';

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
