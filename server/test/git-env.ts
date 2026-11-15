/**
 * Path: server/test/git-env.ts
 * Used by: server/test/{approvals.test,git-clone-access.test,git-policy.test,git-proxy.test,initial-repo.test,pull-requests.test,two-clients.test}.ts.
 * Purpose: A Worker wired to the fake GitHub, plus session and sandbox helpers for the Git tests.
 */

import { mkdtemp } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, Session } from '@cloud-swe/protocol';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { Request as WorkerRequest } from 'miniflare';

import type { FakeGitHub } from './github-fake.ts';
import { modelAnswer } from './model-answer.ts';
import { waitFor } from './rig.ts';
import { forwardOutbound, runtime } from './runtime.ts';

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

            return forwardOutbound(request);
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
    template: 'base',
    model,
  };

  const created = await api('/v1/sessions', 'POST', repo ? { ...request, repo: { url: repo } } : request);

  if (created.status !== 201) throw new Error('Create failed: ' + (await created.text()));

  return CreateSessionResponse.parse(await created.json()).session;
}

export async function getSession(api: Api, id: string) {
  return Session.parse(await (await api('/v1/sessions/' + id)).json());
}

export async function send(api: Api, sessionId: string, text: string) {
  const sent = await api(`/v1/sessions/${sessionId}/messages`, 'POST', { operationId: crypto.randomUUID(), text });

  if (sent.status !== 202) throw new Error('Send failed: ' + (await sent.text()));
}

export function settled(api: Api, sessionId: string) {
  return waitFor(
    () => getSession(api, sessionId),
    (session) => ['completed', 'cancelled', 'failed'].includes(session.run.kind),
  );
}
