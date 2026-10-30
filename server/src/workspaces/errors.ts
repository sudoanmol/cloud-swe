import type { ApiErrorCode } from '@cloud-swe/protocol';
import { Cause, Data } from 'effect';

export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly reason: 'configuration' | 'unavailable' | 'invalid_response' | 'uncertain' | 'expired';
}> {}

export function workspaceError(error: Cause.UnknownError | Cause.TimeoutError | WorkspaceError): WorkspaceError {
  if (error instanceof WorkspaceError) return error;

  if (error.cause instanceof WorkspaceError) return error.cause;

  return new WorkspaceError({ reason: 'unavailable' });
}

/** The API error a client sees for each way a workspace operation can fail. */
export const WORKSPACE_API_ERROR = {
  configuration: 'sandbox_not_configured',
  unavailable: 'sandbox_unreachable',
  invalid_response: 'sandbox_unreachable',
  uncertain: 'sandbox_creation_unconfirmed',
  expired: 'sandbox_creation_unconfirmed',
} satisfies Record<WorkspaceError['reason'], ApiErrorCode>;
