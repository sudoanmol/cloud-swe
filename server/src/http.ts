import { ApiError, type ApiErrorCode } from '@cloud-swe/protocol';
import { HTTPException } from 'hono/http-exception';

import { API_ERRORS, type ErrorParams, renderMessage } from './errors.ts';

export function apiError(code: ApiErrorCode, params?: ErrorParams): Response {
  return Response.json(ApiError.parse({ error: { code, message: renderMessage(code, params) } }), {
    status: API_ERRORS[code].status,
  });
}

export function fail(code: ApiErrorCode, params?: ErrorParams): never {
  throw new HTTPException(API_ERRORS[code].status, { res: apiError(code, params) });
}

export function handleError(error: Error): Response {
  if (error instanceof HTTPException) return error.getResponse();

  return apiError('internal_error');
}
