/**
 * Path: server/test/runtime.ts
 * Used by: server/test/{auth.test,codemode.test,command-recovery.test,compaction.test,controls.test,credentials.test,e2b-live.test,environment-delivery.test,environments.test,event-frames.test,git-env,history-arguments.test,lifecycle-rig,messages.test,model-errors.test,sessions.test,tool-events.test,tools.test,transcript.test}.ts.
 * Purpose: Starts the built Worker in Miniflare with test bindings and a signed-in client.
 */

import { readFileSync, readdirSync } from 'node:fs';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { Miniflare, type MiniflareOptions, type Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';

const template = 'base';
const token = 'integration-test-personal-token';
const model = { provider: 'anthropic', id: 'configured-model' };

// The test entry signs the personal account in, as GitHub sign-in would, so tests can use a fixed bearer token.
const signedInEntry = `
  import app from './index.js';
  export * from './index.js';

  const user = { id: '42', name: 'Octo Cat', email: '42+octo@users.noreply.github.com', githubId: '42' };

  async function signIn(env) {
    const credentials = env.CREDENTIALS.get(env.CREDENTIALS.idFromName('personal'));
    const now = new Date();
    const session = {
      id: 'test-session', token: '${token}', userId: user.id, createdAt: now, updatedAt: now,
      expiresAt: new Date(now.getTime() + 864e5),
    };
    await credentials.authSet('${token}', JSON.stringify({ session, user }), 86400);
    await credentials.setGitHubIdentity({ login: 'octo', name: user.name, email: user.email });
  }

  let signedIn;

  export default {
    async fetch(request, env, context) {
      await (signedIn ??= signIn(env));

      return app.fetch(request, env, context);
    },
  };
`;

/** Sends a Worker's request on to the real network, streaming the answer: E2B holds a command's response open. */
export async function forwardOutbound(request: WorkerRequest) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    body: request.method === 'GET' ? undefined : await request.arrayBuffer(),
  });

  // Fetch has already decompressed the body.
  const headers: [string, string][] = [];

  response.headers.forEach((value, name) => {
    if (name !== 'content-encoding' && name !== 'content-length') headers.push([name, value]);
  });

  // SAFETY: Node's fetch and Miniflare type the same web stream differently.
  const body = response.body as NodeReadableStream<Uint8Array> | null;

  return new WorkerResponse(body, { status: response.status, headers });
}

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
    BETTER_AUTH_SECRET: 'integration-test-secret-integration-test-secret',
    GITHUB_ALLOWED_USER_ID: '42',
    GITHUB_APP_CLIENT_ID: 'unused-in-most-tests',
    GITHUB_APP_CLIENT_SECRET: 'unused-in-most-tests',
    GITHUB_APP_PRIVATE_KEY: 'unused-in-most-tests',
    PUBLIC_URL: 'http://127.0.0.1',
    WORKSPACE_TEMPLATES: `other,${template}`,
    MODEL_PROVIDER: model.provider,
    MODEL_ID: model.id,
    // Docker unless a test asks otherwise: --e2b must reach a real provider only from tests written for one.
    WORKSPACE_BACKEND: 'docker',
    DOCKER_SANDBOX_URL: process.env.DOCKER_SANDBOX_URL ?? 'http://sandbox:9000',
    DOCKER_SANDBOX_TOKEN: process.env.DOCKER_SANDBOX_TOKEN ?? '',
    E2B_API_KEY: process.env.E2B_API_KEY ?? '',
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
            mainModule: 'signed-in.js',
            modules: {
              'signed-in.js': { type: 'esm', contents: signedInEntry },
              'index.js': { type: 'esm', contents: readFileSync('dist/index.js', 'utf8') },
              // Wrangler emits each Markdown prompt as its own text module beside the bundle.
              ...Object.fromEntries(
                readdirSync('dist')
                  .filter((file) => file.endsWith('.md'))
                  .map((file) => [file, { type: 'text' as const, contents: readFileSync(`dist/${file}`, 'utf8') }]),
              ),
            },
          },
          exports: {
            Catalog: { type: 'durable-object', storage: 'sqlite' },
            SessionThread: { type: 'durable-object', storage: 'sqlite' },
            Credentials: { type: 'durable-object', storage: 'sqlite' },
          },
          env: {
            CODEMODE: { type: 'durable-object', worker: 'cloud-swe-codemode', exportName: 'CodemodeSandbox' },
            CREDENTIALS: {
              type: 'durable-object',
              worker: credentialsSwitch ? 'cloud-swe-credentials' : 'cloud-swe-server',
              exportName: 'Credentials',
            },
            CATALOG: { type: 'durable-object', worker: 'cloud-swe-server', exportName: 'Catalog' },
            THREADS: { type: 'durable-object', worker: 'cloud-swe-server', exportName: 'SessionThread' },
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

      async authGet(key) {
        if (key !== '${token}') return null;
        const now = new Date();

        return JSON.stringify({
          session: {
            id: 'test-session', token: '${token}', userId: '42', createdAt: now, updatedAt: now,
            expiresAt: new Date(now.getTime() + 864e5),
          },
          user: { id: '42', name: 'Octo Cat', email: '42+octo@users.noreply.github.com', githubId: '42' },
        });
      }

      async authSet() {}

      async setGitHubIdentity() {}
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
