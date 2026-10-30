import { Cause, Data } from 'effect';

export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly reason: 'configuration' | 'unavailable' | 'invalid_response';
}> {}

export function workspaceError(error: Cause.UnknownError | Cause.TimeoutError | WorkspaceError): WorkspaceError {
  if (error instanceof WorkspaceError) return error;

  if (error.cause instanceof WorkspaceError) return error.cause;

  return new WorkspaceError({ reason: 'unavailable' });
}
