import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';
import type { Provider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

/** Provider diagnostics must never reach Pi's persisted errors/checkpoints verbatim. */
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

  const failure = (aborted: boolean): AssistantMessage => ({
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: aborted ? 'Model request cancelled' : 'Model request failed',
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

  void (async () => {
    try {
      for await (const event of open()) {
        if (event.type === 'error') {
          output.push({ type: 'error', reason: event.reason, error: failure(event.reason === 'aborted') });

          return;
        }

        output.push(event);

        if (event.type === 'done') return;
      }

      output.push({ type: 'error', reason: 'error', error: failure(false) });
    } catch {
      output.push({ type: 'error', reason: 'error', error: failure(false) });
    }
  })();

  return output;
}
