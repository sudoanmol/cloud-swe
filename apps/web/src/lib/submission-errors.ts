import { ThreadApiError } from "@cloud-swe/api/client";

/**
 * Maps the backend's error codes to a sentence a user can act on. Unknown codes
 * fall back to the server's own message rather than inventing a cause.
 */
const MESSAGES = {
  ACTIVE_RUN_LIMIT: "Too many runs are active right now. Wait for one to finish.",
  ADMISSION_UNAVAILABLE: "Compute is temporarily unavailable. Try again in a moment.",
  ATTACHMENT_MESSAGE_TOO_LARGE: "These attachments are too large for one message.",
  ATTACHMENT_NOT_AVAILABLE: "An attachment is missing or no longer available.",
  ATTACHMENT_NOT_READY: "The attachment is still being processed.",
  ATTACHMENT_TOO_LARGE: "That file is larger than 25 MiB.",
  GITHUB_REPOSITORY_REQUIRED: "Select a repository you can write to from the GitHub step.",
  GITHUB_UNAVAILABLE: "GitHub could not be verified. Reconnect the App and try again.",
  IDEMPOTENCY_CONFLICT: "This submission was already used for a different request.",
  IDEMPOTENCY_STATE: "The previous attempt is in an unknown state. Reload before retrying.",
  IMAGE_VARIANT_TOO_LARGE: "That image is too large after resizing.",
  INVALID_ATTACHMENTS: "One of the attachments is no longer usable.",
  INVALID_IMAGE: "That image is corrupt or unsupported.",
  INVALID_UPLOAD: "Upload exactly one file at a time.",
  MODEL_CREDENTIAL_REQUIRED: "Connect a model provider before sending.",
  MODEL_IMAGE_UNSUPPORTED: "The selected model cannot read images.",
  ONBOARDING_REQUIRED: "Finish setup before sending a message.",
  PREVIEWS_UNAVAILABLE: "Previews are not configured on this server.",
  PROVIDER_REQUIRED: "Connect a model provider in onboarding.",
  RATE_LIMITED: "Too many requests. Try again shortly.",
  SSE_LIMIT: "Too many open readers for this thread.",
  THREAD_BUSY: "This thread already has an active run.",
  THREAD_NOT_FOUND: "This thread no longer exists.",
  UNAUTHORIZED: "Your session expired. Sign in again.",
  UPLOAD_CONCURRENCY_LIMIT: "Two uploads are already running. Wait for one to finish.",
} as const satisfies Record<string, string>;

type KnownCode = keyof typeof MESSAGES;

function lookup(code: string): string | undefined {
  if (!Object.hasOwn(MESSAGES, code)) return undefined;

  // SAFETY: `Object.hasOwn` proved `code` is one of this table's literal keys.
  const known = code as KnownCode;

  return MESSAGES[known];
}

/* oxlint-disable anti-slop/no-unknown-parameters -- Errors cross a transport boundary; the only safe domain check is instanceof. */
export function messageForError(error: unknown): string {
  if (error instanceof ThreadApiError) return lookup(error.code) ?? error.message;

  if (error instanceof TypeError) return "The backend is unreachable.";

  return "Something went wrong. Try again.";
}

/** True when retrying the same envelope is safe and useful. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ThreadApiError)
    return error.status === 429 || error.status === 408 || error.status >= 500;

  return true;
}

export function errorCode(error: unknown): string | null {
  return error instanceof ThreadApiError ? error.code : null;
}
