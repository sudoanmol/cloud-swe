import { PageQuery, SessionParams } from '@cloud-swe/protocol';
import type { Hono } from 'hono';

import type { Env } from '../env';
import { apiError } from '../http';
import { hasSession } from './catalog-store';

export function readRoutes(app: Hono, env: Env, storage: DurableObjectStorage) {
  app.on(
    'GET',
    ['/v1/sessions/:sessionId/history', '/v1/sessions/:sessionId/snapshot', '/v1/sessions/:sessionId/events'],
    async (c) => {
      const params = SessionParams.safeParse(c.req.param());

      if (!params.success) return apiError('invalid_request');
      const { sessionId } = params.data;

      if (!(await hasSession(storage, sessionId))) return apiError('session_not_found');
      const thread = env.THREADS.get(env.THREADS.idFromName(sessionId));

      if (c.req.path.endsWith('/snapshot')) return thread.snapshot();

      if (c.req.path.endsWith('/events')) return thread.events();
      const parsed = PageQuery.safeParse(c.req.query());

      if (!parsed.success) return apiError('invalid_request');

      return thread.history(parsed.data);
    },
  );
}
