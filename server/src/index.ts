import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'hono/utils/buffer';

import { credentialRoutes } from './credentials/routes';
import type { Env } from './env';
import { apiError, handleError } from './http';

export { Credentials } from './credentials/store';

export { SessionCatalog, Thread } from './sessions';

const app = new Hono<{ Bindings: Env }>();

app.onError(handleError);

app.use('*', async (c, next) => {
  if (!c.env.API_TOKEN) return apiError(503, 'unavailable', 'API authentication not configured');
  const authorization = c.req.header('Authorization');

  if (!authorization || !(await timingSafeEqual(authorization, `Bearer ${c.env.API_TOKEN}`))) {
    return apiError(401, 'unauthorized', 'Unauthorized');
  }

  await next();
});

app.use(
  '*',
  bodyLimit({ maxSize: 128 * 1024, onError: () => apiError(413, 'invalid_request', 'Request body too large') }),
);

credentialRoutes(app);

app.all('/v1/sessions/*', (c) => c.env.CATALOG.get(c.env.CATALOG.idFromName('personal')).fetch(c.req.raw));

app.all('/v1/sessions', (c) => c.env.CATALOG.get(c.env.CATALOG.idFromName('personal')).fetch(c.req.raw));

app.notFound(() => apiError(404, 'not_found', 'Not found'));

export default app;
