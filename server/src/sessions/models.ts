/**
 * Path: server/src/sessions/models.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Pi model setup: read-only credentials, the usable context cap, and a provider wrapper that replaces provider errors with fixed safe messages Pi classifies the same way.
 */

import type { RunFailureCode, SessionUsage } from '@cloud-swe/protocol';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { Api, AssistantMessage, AssistantMessageEventStream, CredentialStore, Model } from '@earendil-works/pi-ai';
import { createModels, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import type { PiHarness } from 'agents/harness/pi';

import { failureMessage } from './failures.ts';

/** Only Pi's verdicts decide retry and overflow; the patterns just name the category for the client. */
export function classifyProviderError(message: AssistantMessage): RunFailureCode {
  const text = message.errorMessage ?? '';

  if (isContextOverflow(message)) return 'context_overflow';

  if (isRetryableAssistantError(message)) {
    if (/\b429\b|rate.?limit|too many requests/i.test(text)) return 'rate_limited';

    return /\b529\b|overloaded/i.test(text) ? 'overloaded' : 'internal';
  }

  if (/billing|credit balance|quota|usage.?limit/i.test(text)) return 'billing';

  if (/usage policy|refused to complete|stopped with: sensitive/i.test(text)) return 'refused';

  return /\b40[13]\b|authentication|permission_error|unauthorized|api.?key/i.test(text) ? 'auth' : 'unknown';
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

export function sessionModels(readKey: () => Promise<string | undefined>) {
  const models = createModels({
    credentials: secretCredentials(readKey),
    // Never fall back to sandbox/ambient environment or filesystem authentication.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });

  models.setProvider(cappedContext(sanitizedProvider(anthropicProvider())));

  return models;
}

export function secretCredentials(readKey: () => Promise<string | undefined>): CredentialStore {
  return {
    async read(providerId) {
      if (providerId !== 'anthropic') return undefined;
      const key = await readKey();

      return key ? { type: 'api_key', key } : undefined;
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

/**
 * The session's spend: Pi's ledger summed over every conversation, model and tool. Pi keeps one small ledger per
 * conversation, so this reads one record per conversation, not the transcript.
 */
export async function sessionUsage(harness: PiHarness): Promise<SessionUsage> {
  const ledger = await (await harness.pi()).usage(BG);

  const total: SessionUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  for (const usage of [...Object.values(ledger.models), ...Object.values(ledger.tools)]) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    total.cost.input += usage.cost.input;
    total.cost.output += usage.cost.output;
    total.cost.cacheRead += usage.cost.cacheRead;
    total.cost.cacheWrite += usage.cost.cacheWrite;
    total.cost.total += usage.cost.total;
  }

  return total;
}
