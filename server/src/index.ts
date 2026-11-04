/**
 * Path: server/src/index.ts
 * Used by: server/wrangler.jsonc (Worker entry point).
 * Purpose: Body limits and sign-in, then routes credentials and environments to their DO and every session route to Catalog. Exports the Durable Object classes wrangler binds.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { authRoutes, requireSignIn } from './auth.ts';
import { credentialRoutes } from './credentials.ts';
import { catalogStub, type Env } from './env.ts';
import { environmentRoutes } from './environments.ts';
import { apiError, handleError } from './errors.ts';
import { gitProxyRoutes } from './git/proxy.ts';
import { networkProxyRoutes } from './sandbox/network-proxy.ts';

export { Credentials } from './credentials.ts';

// An export name is its Durable Object's identity on Cloudflare: a new name starts with empty storage (see wrangler.jsonc).
// Catalog and SessionThread stay exported, unbound, until migration v6 deletes them in the next deploy.
export { Catalog, Catalog as CatalogV2 } from './sessions/catalog.ts';

export { SessionThread, SessionThread as SessionThreadV2 } from './sessions/thread.ts';

const app = new Hono<{ Bindings: Env }>();

app.onError(handleError);

// Sandboxes carry a per-session capability token, not a signed-in session, and push packs larger than the body limit.
gitProxyRoutes(app);

// The egress daemon carries the session's network capability, and streams request bodies of any size.
networkProxyRoutes(app);

app.use('*', bodyLimit({ maxSize: 128 * 1024, onError: () => apiError('request_too_large') }));

authRoutes(app);

app.use('*', requireSignIn);

credentialRoutes(app);

environmentRoutes(app);

app.all('/v1/sessions/*', (c) => catalogStub(c.env).fetch(c.req.raw));

app.all('/v1/sessions', (c) => catalogStub(c.env).fetch(c.req.raw));

app.notFound(() => apiError('not_found'));

export default app;
