/**
 * Path: server/src/sessions/failures.ts
 * Used by: server/src/sessions/{compaction,messages,models}.ts.
 * Purpose: Run failure codes and the fixed safe message for each, which replaces provider text everywhere Pi stores it.
 */

import { RunFailureCode } from '@cloud-swe/protocol';

// Pi decides retries and overflow compaction by reading this text, so each one must keep its category's classification.
const FAILURE_MESSAGES = {
  rate_limited: 'Model provider rate limit reached',
  overloaded: 'Model provider is overloaded',
  context_overflow: 'Model prompt is too long',
  auth: 'Model provider rejected the credentials',
  billing: 'Model provider billing or quota limit reached',
  refused:
    'The model provider declined this request under its usage policy. If later messages are declined too, start a new session.',
  internal: 'Model provider internal error',
  unknown: 'Model request failed',
} as const satisfies Record<RunFailureCode, string>;

export function failureMessage(code: RunFailureCode): string {
  return FAILURE_MESSAGES[code];
}

/** Reads a saved safe message back. Anything else, such as an orphaned compaction's reason, stays unknown and unshown. */
export function failureFromDetail(detail: string | undefined) {
  const code = RunFailureCode.options.find((candidate) => detail?.includes(FAILURE_MESSAGES[candidate])) ?? 'unknown';

  return { code, message: FAILURE_MESSAGES[code] };
}
