import { readFileSync } from 'node:fs';

import { Miniflare, type MiniflareOptions } from 'miniflare';

const environment = 'base';
const token = 'integration-test-personal-token';
const model = { provider: 'anthropic', id: 'configured-model' };
const backend = process.env.WORKSPACE_BACKEND ?? 'docker';

export function runtime(
  storage: string,
  overrides: Record<string, string> = {},
  dev?: MiniflareOptions['workers'][number]['dev'],
) {
  const values = {
    API_TOKEN: token,
    WORKSPACE_ENVIRONMENTS: `other,${environment}`,
    MODEL_PROVIDER: model.provider,
    MODEL_ID: model.id,
    WORKSPACE_BACKEND: backend,
    DOCKER_SANDBOX_URL: process.env.DOCKER_SANDBOX_URL ?? 'http://sandbox:9000',
    DOCKER_SANDBOX_TOKEN: process.env.DOCKER_SANDBOX_TOKEN ?? '',
    BOAT_API_KEY: process.env.BOAT_API_KEY ?? '',
    ...overrides,
  };

  return new Miniflare({
    resourcePersistencePath: storage,
    unsafeInspectDurableObjects: true,
    workers: [
      {
        dev,
        config: {
          name: 'cloud-swe-server',
          compatibilityDate: '2026-10-29',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': { type: 'esm', contents: readFileSync('dist/index.js', 'utf8') },
            },
          },
          exports: {
            SessionCatalog: { type: 'durable-object', storage: 'sqlite' },
            Thread: { type: 'durable-object', storage: 'sqlite' },
          },
          env: {
            CATALOG: { type: 'durable-object', worker: 'cloud-swe-server', exportName: 'SessionCatalog' },
            THREADS: { type: 'durable-object', worker: 'cloud-swe-server', exportName: 'Thread' },
            ...Object.fromEntries(
              Object.entries(values).map(([key, value]) => [
                key,
                { type: 'json', value } satisfies { type: 'json'; value: string },
              ]),
            ),
          },
        },
      },
    ],
  });
}
