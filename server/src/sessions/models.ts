/**
 * Path: server/src/sessions/models.ts
 * Used by: server/src/sessions/{compaction,messages,thread}.ts.
 * Purpose: Pi model setup: read-only credentials, the usable context cap, and a provider wrapper that replaces provider errors with fixed safe messages Pi classifies the same way.
 */

import { RunFailureCode } from '@cloud-swe/protocol';
import type { Api, AssistantMessage, AssistantMessageEventStream, CredentialStore, Model } from '@earendil-works/pi-ai';
import { createModels, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';

import type { Env } from '../env.ts';

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

/** Provider diagnostics must never reach Pi's persisted errors/checkpoints verbatim; a fixed message classifies the same. */
export function sanitizedProvider<TApi extends Api>(provider: Provider<TApi>): Provider<TApi> {
  return {
    ...provider,
    stream: (model, context, options) => sanitizedStream(model, () => provider.stream(model, context, options)),
    streamSimple: (model, context, options) =>
      sanitizedStream(model, () => provider.streamSimple(model, context, options)),
  };
}

function sanitizedStream(model: Model<Api>, open: () => AssistantMessageEventStream): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  const message = (aborted: boolean, errorMessage: string): AssistantMessage => ({
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  const failure = (aborted: boolean, raw: string) =>
    aborted
      ? message(true, 'Model request cancelled')
      : message(false, failureMessage(classifyProviderError(message(false, raw))));

  void (async () => {
    try {
      for await (const event of open()) {
        if (event.type === 'error') {
          output.push({
            type: 'error',
            reason: event.reason,
            error: failure(event.reason === 'aborted', event.error.errorMessage ?? ''),
          });

          return;
        }

        output.push(event);

        if (event.type === 'done') return;
      }

      output.push({ type: 'error', reason: 'error', error: failure(false, 'Provider stream ended without a result') });
    } catch (error) {
      output.push({ type: 'error', reason: 'error', error: failure(false, String(error)) });
    }
  })();

  return output;
}

// Long-context models get noticeably worse past this, so Pi compacts against it instead of the catalog's window.
const USABLE_CONTEXT_TOKENS = 500_000;

function cappedContext<TApi extends Api>(provider: Provider<TApi>): Provider<TApi> {
  return {
    ...provider,
    getModels: () =>
      provider.getModels().map((model) => ({
        ...model,
        contextWindow: Math.min(model.contextWindow, USABLE_CONTEXT_TOKENS),
      })),
  };
}

export function sessionModels(env: Pick<Env, 'ANTHROPIC_API_KEY'>, readKey?: () => Promise<string | undefined>) {
  const models = createModels({
    credentials: secretCredentials(env, readKey),
    // Never fall back to sandbox/ambient environment or filesystem authentication.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });

  models.setProvider(cappedContext(sanitizedProvider(anthropicProvider())));

  return models;
}

export function secretCredentials(
  env: Pick<Env, 'ANTHROPIC_API_KEY'>,
  readKey: () => Promise<string | undefined> = async () => env.ANTHROPIC_API_KEY?.trim() || undefined,
): CredentialStore {
  return {
    async read(providerId) {
      if (providerId !== 'anthropic') return undefined;
      const key = await readKey();

      return providerId === 'anthropic' && key ? { type: 'api_key', key } : undefined;
    },
    async list() {
      const key = await readKey();

      return key ? [{ providerId: 'anthropic', type: 'api_key' }] : [];
    },
    async modify() {
      throw new Error('Worker credentials are read-only');
    },
    async delete() {
      throw new Error('Worker credentials are read-only');
    },
  };
}
