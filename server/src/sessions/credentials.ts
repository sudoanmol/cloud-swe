import type { CredentialStore } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

import type { Env } from '../env';

export function sessionModels(env: Pick<Env, 'ANTHROPIC_API_KEY'>) {
  const models = createModels({
    credentials: secretCredentials(env),
    // Only explicitly configured Worker secrets may authenticate model calls.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });

  models.setProvider(anthropicProvider());

  return models;
}

export function secretCredentials(env: Pick<Env, 'ANTHROPIC_API_KEY'>): CredentialStore {
  const key = env.ANTHROPIC_API_KEY?.trim();

  return {
    async read(providerId) {
      return providerId === 'anthropic' && key ? { type: 'api_key', key } : undefined;
    },
    async list() {
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
