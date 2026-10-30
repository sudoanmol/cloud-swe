import { readFileSync, readdirSync } from 'node:fs';

import { Miniflare, type MiniflareOptions } from 'miniflare';

const environment = 'base';
const token = 'integration-test-personal-token';
const model = { provider: 'anthropic', id: 'configured-model' };
const backend = process.env.WORKSPACE_BACKEND ?? 'docker';

export function runtime(
  storage: string,
  overrides: Record<string, string> = {},
  dev?: MiniflareOptions['workers'][number]['dev'],
  // When set, the account Credentials DO runs in its own Worker, and fails while this fetcher answers 'down'.
  credentialsSwitch?: MiniflareOptions['workers'][number]['dev'],
  // Listen on all interfaces so a sandbox container can call the Worker (the Git proxy tests).
  listen?: { host: string; port: number },
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
    ...listen,
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
            Credentials: { type: 'durable-object', storage: 'sqlite' },
          },
          env: {
            CODEMODE: { type: 'durable-object', worker: 'cloud-swe-codemode', exportName: 'CodemodeSandbox' },
            CREDENTIALS: {
              type: 'durable-object',
              worker: credentialsSwitch ? 'cloud-swe-credentials' : 'cloud-swe-server',
              exportName: 'Credentials',
            },
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
      {
        config: {
          name: 'cloud-swe-codemode',
          compatibilityDate: '2026-10-29',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'codemode.js',
            modules: {
              'codemode.js': { type: 'esm', contents: readFileSync('dist/codemode/codemode.js', 'utf8') },
              ...Object.fromEntries(
                readdirSync('dist/codemode')
                  .filter((name) => name.endsWith('.wasm'))
                  .map((name) => [
                    name,
                    { type: 'wasm', contents: readFileSync('dist/codemode/' + name) } satisfies {
                      type: 'wasm';
                      contents: Uint8Array;
                    },
                  ]),
              ),
            },
          },
          exports: { CodemodeSandbox: { type: 'durable-object', storage: 'sqlite' } },
        },
      },
      ...(credentialsSwitch ? [switchedCredentials(credentialsSwitch)] : []),
    ],
  });
}

function switchedCredentials(dev: NonNullable<MiniflareOptions['workers'][number]['dev']>) {
  const contents = `
    import { DurableObject } from 'cloudflare:workers';

    export class Credentials extends DurableObject {
      async modelKey() {
        if (await (await fetch('http://switch/')).text() === 'down') throw new Error('credentials unavailable');

        return 'fake-key';
      }
    }

    export default { fetch: () => new Response('unused') };
  `;

  return {
    dev,
    config: {
      name: 'cloud-swe-credentials',
      compatibilityDate: '2026-10-29',
      manifest: { mainModule: 'credentials.js', modules: { 'credentials.js': { type: 'esm', contents } } },
      exports: { Credentials: { type: 'durable-object', storage: 'sqlite' } },
    },
  } satisfies MiniflareOptions['workers'][number];
}
