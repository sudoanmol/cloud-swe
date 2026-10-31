import { ModelCredentialParams, SetModelCredentialRequest } from '@cloud-swe/protocol/credentials';
import type { Hono } from 'hono';

import type { Env } from '../env.ts';
import { apiError } from '../http.ts';

export function credentialRoutes(app: Hono<{ Bindings: Env }>) {
  app.on(['GET', 'PUT', 'DELETE'], '/v1/credentials/models/:provider', async (c) => {
    if (!ModelCredentialParams.safeParse(c.req.param()).success) return apiError('unsupported_provider');
    c.header('Cache-Control', 'no-store');
    const store = c.env.CREDENTIALS.get(c.env.CREDENTIALS.idFromName('personal'));

    if (c.req.method === 'GET') return c.json(await store.modelStatus());

    if (c.req.method === 'DELETE') return c.json(await store.deleteModelKey());
    const parsed = SetModelCredentialRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError('invalid_request');

    return c.json(await store.setModelKey(parsed.data));
  });
}
