/**
 * Path: server/src/errors.ts
 * Used by: server/src/{auth,credentials,environments,follow-ups,index}.ts, server/src/sessions/{attachments,cancellation,catalog,compaction,conversations,create,messages,routes,summary,thread,transcript,workspace-lifecycle,workspace-ready}.ts, server/src/tools/{environment,questions,secret-requests}.ts, server/src/workspaces/settings.ts.
 * Purpose: The only place API errors are defined: wire code (the key), HTTP status and the message a client shows a person. Add API errors here and nowhere else. Also the Result domain code returns instead of a response, and the rendering of both as responses.
 */

import { ApiError, type ApiErrorCode } from '@cloud-swe/protocol';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

type ErrorParams = Record<string, string | number>;

export const API_ERRORS = {
  unauthorized: { status: 401, message: 'You are not signed in. Check your access token and try again.' },
  api_not_configured: {
    status: 503,
    message: "The server's sign-in isn't set up yet. Finish setting it up, then try again.",
  },
  request_too_large: { status: 413, message: 'That request is too large. Shorten it and try again.' },
  invalid_request: { status: 400, message: "That request wasn't valid. Check it and try again." },
  invalid_cursor: { status: 400, message: 'That page of results is no longer valid. Reload the list and try again.' },
  unknown_template: { status: 400, message: "That sandbox template isn't available. Pick another one and try again." },
  unknown_environment: {
    status: 400,
    message: "That environment doesn't exist. Create it or pick another one, then try again.",
  },
  environment_not_found: { status: 404, message: "That environment doesn't exist. It may have been deleted." },
  environment_limit: {
    status: 409,
    message: 'You have reached the limit for environments or their secrets. Remove one, then try again.',
  },
  secret_name_conflict: {
    status: 409,
    message: 'That name is already used by the other kind of secret in this environment. Pick another name.',
  },
  invalid_host: { status: 400, message: "Network secrets can't be sent to that host. Use the API's own host name." },
  no_environment: {
    status: 409,
    message: 'This session has no environment. Start a session with an environment to store secrets.',
  },
  unknown_model: { status: 400, message: "That model isn't available. Pick another one and try again." },
  unsupported_provider: { status: 400, message: "That provider isn't supported." },
  not_found: { status: 404, message: "We couldn't find what you asked for." },
  session_not_found: { status: 404, message: "That session doesn't exist. It may have been removed." },
  operation_not_found: { status: 404, message: "We couldn't find that action. Check its ID and try again." },
  question_not_found: { status: 404, message: "That question doesn't exist. It may have been removed." },
  secret_request_not_found: { status: 404, message: "That secret request doesn't exist. It may have been removed." },
  conversation_not_found: {
    status: 404,
    message: "That conversation doesn't exist in this session. Reload the session and try again.",
  },
  conversation_not_active: {
    status: 409,
    message: 'This session has moved on to another conversation. Reload the session and continue there.',
  },
  entry_not_found: {
    status: 404,
    message: "That point in the conversation wasn't found. Reload the conversation and try again.",
  },
  attachment_not_found: {
    status: 404,
    message: "We couldn't find that image. Upload it again, then send your message.",
  },
  attachment_too_large: { status: 413, message: 'That image is too large. Shrink it and try again.' },
  attachment_dimensions_too_large: {
    status: 422,
    message: 'That image is too many pixels wide or tall for the model. Shrink it and try again.',
  },
  attachment_type_unsupported: {
    status: 415,
    message: "That file type can't be attached. Attach a PNG, JPEG, GIF or WebP image.",
  },
  invalid_sign_in_code: { status: 400, message: 'That sign-in expired or was already used. Sign in again.' },
  invalid_redirect: {
    status: 400,
    message: "This sign-in can't return to your app. Update the app, then sign in again.",
  },
  operation_conflict: {
    status: 409,
    message: 'That action ID was already used for something different. Start the action again.',
  },
  run_not_active: {
    status: 409,
    message: "That work already finished or isn't running, so there is nothing to cancel.",
  },
  compaction_running: { status: 409, message: 'This session is already compacting. Wait for it to finish.' },
  session_busy: {
    status: 409,
    message: 'This session is still working. Wait for it to finish, or send your message as a follow-up.',
  },
  session_not_idle: {
    status: 409,
    message: 'This session is still working. Wait for it to finish, or cancel the run, then try again.',
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

/** An API error a domain call ends in, as plain data until `respond` makes it a response. */
export type ApiFailure = { ok: false; code: ApiErrorCode; params?: ErrorParams };

/** What a domain call returns instead of a response: its value, or the API error. */
export type Result<T> = { ok: true; value: T } | ApiFailure;

export const failure = (code: ApiErrorCode, params?: ErrorParams): ApiFailure => ({ ok: false, code, params });

export const success = <T>(value: T): Result<T> => ({ ok: true, value });

/**
 * The one way a domain result becomes an HTTP response: its value as JSON with `status` (a null value has no body), or
 * the API error.
 */
export function respond<T>(result: Result<T>, status = 200): Response {
  if (!result.ok) return apiError(result.code, result.params);

  return result.value === null ? new Response(null, { status }) : Response.json(result.value, { status });
}

export function fail(code: ApiErrorCode, params?: ErrorParams): never {
  throw new HTTPException(API_ERRORS[code].status, { res: apiError(code, params) });
}

/**
 * Logs that something unexpected was thrown, as one object Workers Logs indexes by field. Only the error's class: a
 * message can carry upstream text or a secret.
 */
export function logFault(what: string, error: Error, sessionId?: string): void {
  // oxlint-disable-next-line eslint/no-console -- the Worker's one log sink; Workers Logs indexes an object's fields.
  console.error({ message: what, error: error.name, sessionId });
}

export function handleError(error: Error): Response {
  if (error instanceof HTTPException) return error.getResponse();
  logFault('Unhandled request error', error);

  return apiError('internal_error');
}
