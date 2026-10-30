/**
 * Path: server/src/sessions/model-failure.ts
 * Used by: server/src/sessions/{model-stream,message-state}.ts.
 * Purpose: Sorts provider errors into a closed set of codes, each with a fixed safe message that Pi's classifiers treat as they would the original.
 */
import { RunFailureCode } from '@cloud-swe/protocol';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';

// Pi decides retries and overflow compaction by reading this text, so each one must keep its category's classification.
const FAILURE_MESSAGES = {
  rate_limited: 'Model provider rate limit reached',
  overloaded: 'Model provider is overloaded',
  context_overflow: 'Model prompt is too long',
  auth: 'Model provider rejected the credentials',
  billing: 'Model provider billing or quota limit reached',
  internal: 'Model provider internal error',
  unknown: 'Model request failed',
} as const satisfies Record<RunFailureCode, string>;

export function failureMessage(code: RunFailureCode): string {
  return FAILURE_MESSAGES[code];
}

/** Only Pi's verdicts decide retry and overflow; the patterns just name the category for the client. */
export function classifyProviderError(message: AssistantMessage): RunFailureCode {
  const text = message.errorMessage ?? '';

  if (isContextOverflow(message)) return 'context_overflow';

  if (isRetryableAssistantError(message)) {
    if (/\b429\b|rate.?limit|too many requests/i.test(text)) return 'rate_limited';

    return /\b529\b|overloaded/i.test(text) ? 'overloaded' : 'internal';
  }

  if (/billing|credit balance|quota|usage.?limit/i.test(text)) return 'billing';

  return /\b40[13]\b|authentication|permission_error|unauthorized|api.?key/i.test(text) ? 'auth' : 'unknown';
}

/** Reads a saved safe message back. Anything else, such as an orphaned compaction's reason, stays unknown and unshown. */
export function failureFromDetail(detail: string | undefined) {
  const code = RunFailureCode.options.find((candidate) => detail?.includes(FAILURE_MESSAGES[candidate])) ?? 'unknown';

  return { code, message: FAILURE_MESSAGES[code] };
}
