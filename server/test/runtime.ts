/**
 * Path: server/test/runtime.ts
 * Used by: server/test/{auth.test,credentials.test,e2b-live.test,egress.test,environments.test,git-env,lifecycle-rig,messages.test,network-proxy.test,rig,secret-requests.test,sessions.test}.ts.
 * Purpose: Starts the built Worker in Miniflare with test bindings and a signed-in client.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { setTimeout } from 'node:timers/promises';

import { Miniflare, type MiniflareOptions, type Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';

const template = 'base';

/** The signed-in test account's bearer token, which the test entry registers. */
export const token = 'integration-test-personal-token';

/** The model the Worker is configured with when a test sets no MODEL_ID. */
export const configuredModel = { provider: 'anthropic', id: 'configured-model' };

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

/**
 * A 200 whose body sends `chunks` and then fails. Miniflare ends a broken handler body cleanly, so the cut is made real: a
 * declared length the body never reaches, on a connection that closes after it, ends early for the Worker.
 */
export function cutResponse(chunks: readonly string[]) {
  let sent = 0;

  const body = new NodeReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks[sent++];

      if (chunk === undefined) controller.error(new Error('upstream died'));
      else controller.enqueue(new TextEncoder().encode(chunk));
      await setTimeout(50);
    },
  });

  return new WorkerResponse(body, { status: 200, headers: { 'Content-Length': '1000000', Connection: 'close' } });
}

/**
 * A root-only egress setup request (the daemon config write or its apply), which the plain double can't run: its parsed
 * body and the daemon config it carries. Undefined for any other request.
 */
export function rootSetup(method: string, path: string, text: string) {
  if (method !== 'POST' || !/\/(file|exec)$/.test(path)) return undefined;
  const body = JSON.parse(text);

  if (body.user !== 'root') return undefined;

  return {
    body,
    egress: String(body.path).endsWith('egress.json.next') ? JSON.parse(body.content) : undefined,
    reply: path.endsWith('/exec') ? { exitCode: 0, stdout: 'applied\n' } : { written: true },
  };
}

type WorkerDev = MiniflareOptions['workers'][number]['dev'];

export type RuntimeOptions = {
  /** Worker bindings over the test defaults. */
  bindings?: Record<string, string>;
  /** Where the Worker's outbound requests go. */
  dev?: WorkerDev;
  /** When set, the account Credentials DO runs in its own Worker, and fails while this fetcher answers 'down'. */
  credentialsSwitch?: WorkerDev;
  /** Listen on all interfaces so a sandbox container can call the Worker (the Git proxy tests). */
  listen?: { host: string; port: number };
  workers?: MiniflareOptions['workers'];
};

export function runtime(
  storage: string,
  { bindings: overrides = {}, dev, credentialsSwitch, listen, workers: additionalWorkers = [] }: RuntimeOptions = {},
) {
  const values = {
    BETTER_AUTH_SECRET: 'integration-test-secret-integration-test-secret',
    GITHUB_ALLOWED_USER_ID: '42',
    GITHUB_APP_CLIENT_ID: 'unused-in-most-tests',
    GITHUB_APP_CLIENT_SECRET: 'unused-in-most-tests',
    GITHUB_APP_PRIVATE_KEY: 'unused-in-most-tests',
    PUBLIC_URL: 'http://127.0.0.1',
    WORKSPACE_TEMPLATES: `other,${template}`,
    MODEL_PROVIDER: configuredModel.provider,
    MODEL_ID: configuredModel.id,
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
            CatalogV2: { type: 'durable-object', storage: 'sqlite' },
            SessionThreadV2: { type: 'durable-object', storage: 'sqlite' },
            Credentials: { type: 'durable-object', storage: 'sqlite' },
          },
          env: {
            CODEMODE: { type: 'durable-object', worker: 'cloud-swe-codemode', exportName: 'CodemodeSandbox' },
            CREDENTIALS: {
              type: 'durable-object',
              worker: credentialsSwitch ? 'cloud-swe-credentials' : 'cloud-swe-server',
              exportName: 'Credentials',
            },
            CATALOG: { type: 'durable-object', worker: 'cloud-swe-server', exportName: 'CatalogV2' },
            THREADS: { type: 'durable-object', worker: 'cloud-swe-server', exportName: 'SessionThreadV2' },
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
      ...additionalWorkers,
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
