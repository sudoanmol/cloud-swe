/**
 * Path: server/src/workspaces/errors.ts
 * Used by: server/src/sessions/{create,workspace-lifecycle}.ts, server/src/workspaces/{boat,docker,index}.ts.
 * Purpose: WorkspaceError, and the API error a client sees for each way a workspace operation can fail.
 */

import type { ApiErrorCode } from '@cloud-swe/protocol';
import { type Cause, Data } from 'effect';

export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly reason: 'configuration' | 'unavailable' | 'invalid_response' | 'uncertain' | 'expired' | 'refused';
}> {}

export function workspaceError(error: Cause.UnknownError | Cause.TimeoutError | WorkspaceError): WorkspaceError {
  if (error instanceof WorkspaceError) return error;

  if (error.cause instanceof WorkspaceError) return error.cause;

  return new WorkspaceError({ reason: 'unavailable' });
}

/**
 * Whether an HTTP status means the service rejected a request before acting on it, so nothing exists afterwards.
 * 408 and 409 can follow a request that did start (a timeout; an idempotency conflict), so they are not refusals.
 */
export const isRefusal = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 409;

/** The API error a client sees for each way a workspace operation can fail. */
export const WORKSPACE_API_ERROR = {
  configuration: 'sandbox_not_configured',
  unavailable: 'sandbox_unreachable',
  invalid_response: 'sandbox_unreachable',
  uncertain: 'sandbox_creation_unconfirmed',
  expired: 'sandbox_creation_unconfirmed',
  refused: 'sandbox_refused',
} satisfies Record<WorkspaceError['reason'], ApiErrorCode>;
