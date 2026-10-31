/**
 * Path: server/test/git-env.ts
 * Used by: server/test/{approvals.test,git-clone-access.test,git-policy.test,git-proxy.test,initial-repo.test,pull-requests.test}.ts.
 * Purpose: A Worker wired to the fake GitHub, plus session and sandbox helpers for the Git tests.
 */

import { mkdtemp } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, Session } from '@cloud-swe/protocol';
import { FileContent } from '@cloud-swe/protocol/tools';
import type { ToolCall } from '@earendil-works/pi-ai';
import { type Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';

import type { FakeGitHub } from './github-fake.ts';
import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

export const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };

const auth = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };

type Call = Pick<ToolCall, 'id' | 'name' | 'arguments'>;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One Worker with fake GitHub, a scripted model and the real Docker sandbox. `calls` holds one tool round per model turn. */
export async function gitWorker(
  fake: FakeGitHub,
  port: number,
  calls: Call[][] = [],
  bodies: string[] = [],
  settings: Record<string, string> = {},
) {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-git-'));

  const start = () =>
    runtime(
      storage,
      {
        MODEL_ID: model.id,
        ANTHROPIC_API_KEY: 'fake-key',
        PUBLIC_URL: `http://${hostname()}:${port}`,
        ...fake.appSettings,
        ...settings,
      },
      {
        outboundService: {
          type: 'fetcher',
          handler: async (request: WorkerRequest) => {
            const host = new URL(request.url).hostname;

            if (host === 'api.anthropic.com') {
              bodies.push(await request.text());

              return modelAnswer(model.id, calls.shift() ?? []);
            }

            if (host === 'api.github.com' || host === 'github.com') return fake.handle(request);

            const response = await fetch(request.url, {
              method: request.method,
              headers: [...request.headers],
              body: request.method === 'GET' ? undefined : await request.text(),
            });

            return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
          },
        },
      },
      undefined,
      { host: '0.0.0.0', port },
    );

  let mf = start();
  const base = await mf.ready;

  const api = (path: string, method = 'GET', body?: Json) => {
    const init: RequestInit = { method, headers: auth };

    if (body !== undefined) init.body = JSON.stringify(body);

    return fetch(new URL(path, base), init);
  };

  return {
    get mf() {
      return mf;
    },
    base,
    api,
    storage,
    /** Stops the Worker, runs `whileDown` against its stored files, and starts it again on the same port. */
    restart: async (whileDown: () => Promise<void>) => {
      await mf.dispose();
      await whileDown();

      // The old process can hold the fixed port for a moment, and the new one then exits on start.
      for (let attempt = 0; ; attempt++) {
        mf = start();

        try {
          await mf.ready;

          return;
        } catch (error) {
          await mf.dispose().catch(() => undefined);

          if (attempt === 20) throw error;
          await setTimeout(250);
        }
      }
    },
  };
}

type Api = Awaited<ReturnType<typeof gitWorker>>['api'];

export async function createSession(api: Api, repo?: string) {
  const request = {
    operationId: crypto.randomUUID(),
    engine: 'pi',
    target: 'cloud',
    environment: 'base',
    model,
  };

  const created = await api('/v1/sessions', 'POST', repo ? { ...request, repo: { url: repo } } : request);

  if (created.status !== 201) throw new Error('Create failed: ' + (await created.text()));

  return CreateSessionResponse.parse(await created.json()).session;
}

export async function getSession(api: Api, id: string) {
  return Session.parse(await (await api('/v1/sessions/' + id)).json());
}

export async function until<T>(read: () => Promise<T | undefined>, what: string, attempts = 400): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read();

    if (value !== undefined) return value;
    await setTimeout(50);
  }

  throw new Error('Timed out waiting for ' + what);
}

export async function send(api: Api, sessionId: string, text: string) {
  const sent = await api(`/v1/sessions/${sessionId}/messages`, 'POST', { operationId: crypto.randomUUID(), text });

  if (sent.status !== 202) throw new Error('Send failed: ' + (await sent.text()));
}

export async function settled(api: Api, sessionId: string) {
  return until(async () => {
    const session = await getSession(api, sessionId);

    return session.run.kind === 'completed' || session.run.kind === 'failed' ? session : undefined;
  }, 'the run to settle');
}

const sandboxUrl = (workspaceId: string, route: string) =>
  new URL(`/workspaces/${workspaceId}/${route}`, process.env.DOCKER_SANDBOX_URL ?? 'http://sandbox:9000');

const sandboxAuth = { Authorization: `Bearer ${process.env.DOCKER_SANDBOX_TOKEN ?? ''}` };

export async function sandboxFile(workspaceId: string, path: string): Promise<string | undefined> {
  const response = await fetch(sandboxUrl(workspaceId, 'file?path=' + encodeURIComponent(path)), {
    headers: sandboxAuth,
  });

  if (!response.ok) return undefined;

  return FileContent.parse(await response.json()).content;
}

/** Runs a script in the session's sandbox (outside any Pi tool) and returns its output and exit code. */
export async function sandboxRun(workspaceId: string, script: string) {
  const name = crypto.randomUUID();
  const command = `( ${script} ) > .${name}.out 2>&1; echo $? > .${name}.rc`;

  const started = await fetch(sandboxUrl(workspaceId, 'commands'), {
    method: 'POST',
    headers: { ...sandboxAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });

  if (!started.ok) throw new Error('Sandbox command failed to start');
  const code = await until(() => sandboxFile(workspaceId, `.${name}.rc`), 'the sandbox command', 600);

  return { code: Number.parseInt(code, 10), output: (await sandboxFile(workspaceId, `.${name}.out`)) ?? '' };
}
