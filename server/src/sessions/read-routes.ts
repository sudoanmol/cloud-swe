import { PageQuery, SessionParams } from '@cloud-swe/protocol';
import type { Hono } from 'hono';

import type { Env } from '../env';
import { apiError } from '../http';

export function readRoutes(app: Hono, env: Env, storage: DurableObjectStorage) {
  app.on(
    'GET',
    ['/v1/sessions/:sessionId/history', '/v1/sessions/:sessionId/snapshot', '/v1/sessions/:sessionId/events'],
    async (c) => {
      const params = SessionParams.safeParse(c.req.param());

      if (!params.success) return apiError(400, 'invalid_request', 'Invalid session ID');
      const { sessionId } = params.data;

      if ((await storage.get(`id:${sessionId}`)) === undefined) return apiError(404, 'not_found', 'Session not found');
      const thread = env.THREADS.get(env.THREADS.idFromName(sessionId));

      if (c.req.path.endsWith('/snapshot')) return thread.snapshot();

      if (c.req.path.endsWith('/events')) return thread.events();
      const parsed = PageQuery.safeParse(c.req.query());

      if (!parsed.success) return apiError(400, 'invalid_request', 'Invalid pagination');

      return thread.history(parsed.data);
    },
  );
}
