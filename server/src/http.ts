import { ApiError } from '@cloud-swe/protocol';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export function apiError(status: ContentfulStatusCode, code: ApiError['error']['code'], message: string): Response {
  return Response.json(ApiError.parse({ error: { code, message } }), { status });
}

export function fail(status: ContentfulStatusCode, code: ApiError['error']['code'], message: string): never {
  throw new HTTPException(status, { res: apiError(status, code, message) });
}

export function handleError(error: Error): Response {
  if (error instanceof HTTPException) return error.getResponse();

  return apiError(500, 'internal_error', 'Internal server error');
}
