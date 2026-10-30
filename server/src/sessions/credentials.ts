import type { Api, CredentialStore } from '@earendil-works/pi-ai';
import { createModels, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

import type { Env } from '../env';
import { sanitizedProvider } from './model-stream.ts';

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
