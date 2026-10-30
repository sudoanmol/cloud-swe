import type { CredentialStore } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

import type { Env } from '../env';
import { sanitizedProvider } from './model-stream.ts';

export function sessionModels(env: Pick<Env, 'ANTHROPIC_API_KEY'>, readKey?: () => Promise<string | undefined>) {
  const models = createModels({
    credentials: secretCredentials(env, readKey),
    // Never fall back to sandbox/ambient environment or filesystem authentication.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });

  models.setProvider(sanitizedProvider(anthropicProvider()));

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
