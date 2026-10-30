import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';
import type { Provider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

import { classifyProviderError, failureMessage } from './model-failure.ts';

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
