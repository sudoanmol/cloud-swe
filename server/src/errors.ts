/**
 * Path: server/src/errors.ts
 * Used by: server/src/{auth,credentials,index}.ts, server/src/git/approvals.ts, server/src/sessions/{cancellation,catalog,create,messages,routes,thread,transcript,workspace-lifecycle}.ts.
 * Purpose: The only place API errors are defined: wire code (the key), HTTP status and the message a client shows a person. Add API errors here and nowhere else. Also renders them as responses.
 */

import { ApiError, type ApiErrorCode } from '@cloud-swe/protocol';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorParams = Record<string, string | number>;

export const API_ERRORS = {
  unauthorized: { status: 401, message: 'You are not signed in. Check your access token and try again.' },
  api_not_configured: {
    status: 503,
    message: "The server's sign-in isn't set up yet. Finish setting it up, then try again.",
  },
  request_too_large: { status: 413, message: 'That request is too large. Shorten it and try again.' },
  invalid_request: { status: 400, message: "That request wasn't valid. Check it and try again." },
  invalid_cursor: { status: 400, message: 'That page of results is no longer valid. Reload the list and try again.' },
  unknown_environment: { status: 400, message: "That environment isn't available. Pick another one and try again." },
  unknown_model: { status: 400, message: "That model isn't available. Pick another one and try again." },
  unsupported_provider: { status: 400, message: "That provider isn't supported." },
  not_found: { status: 404, message: "We couldn't find what you asked for." },
  session_not_found: { status: 404, message: "That session doesn't exist. It may have been removed." },
  operation_not_found: { status: 404, message: "We couldn't find that action. Check its ID and try again." },
  approval_not_found: { status: 404, message: "That approval doesn't exist. It may have been removed." },
  operation_conflict: {
    status: 409,
    message: 'That action ID was already used for something different. Start the action again.',
  },
  approval_already_decided: { status: 409, message: 'This approval was already decided the other way.' },
  run_not_active: {
    status: 409,
    message: "That work already finished or isn't running, so there is nothing to cancel.",
  },
  compaction_running: { status: 409, message: 'This session is already compacting. Wait for it to finish.' },
  session_busy: {
    status: 409,
    message: 'This session is still working. Wait for it to finish, or send your message as a follow-up.',
  },
  session_settling: {
    status: 409,
    message: 'This session is still wrapping up earlier work. Wait a moment, then try again.',
  },
  input_queue_full: {
    status: 409,
    message: 'Too many messages are waiting in this session. Wait for some to finish, then try again.',
  },
  sandbox_limit_reached: {
    status: 409,
    message: "You've reached your limit of {limit} running sandboxes. Wait for one to stop, then try again.",
  },
  sandbox_not_ready: { status: 503, message: "This session's sandbox isn't ready yet. Try again in a moment." },
  sandbox_unreachable: { status: 503, message: "We couldn't reach the sandbox service. Try again in a moment." },
  sandbox_not_configured: {
    status: 503,
    message: "Sandboxes aren't set up on the server yet. Finish the setup, then try again.",
  },
  sandbox_creation_unconfirmed: {
    status: 503,
    message: "We couldn't confirm whether your sandbox was created. Check your sandboxes, then start a new session.",
  },
  sandbox_refused: {
    status: 503,
    message:
      'The sandbox service declined to create a sandbox. Check your sandbox account and settings, then try again.',
  },
  model_unavailable: {
    status: 503,
    message: 'No model is ready to use. Add your model API key in settings, then try again.',
  },
  message_unconfirmed: {
    status: 503,
    message: "We couldn't confirm your message was received. Try again; it won't be sent twice.",
  },
  cancel_unconfirmed: { status: 503, message: "We couldn't confirm the work was stopped. Try cancelling again." },
  internal_error: { status: 500, message: 'Something went wrong on our side. Try again in a moment.' },
} satisfies Record<ApiErrorCode, { status: ContentfulStatusCode; message: string }>;

/** Fills `{name}` placeholders in a catalog message. */
export function renderMessage(code: ApiErrorCode, params: ErrorParams = {}): string {
  return API_ERRORS[code].message.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}

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
