/**
 * Path: server/test/git-env.ts
 * Used by: server/test/{approvals.test,git-clone-access.test,git-policy.test,git-proxy.test,github-live.test,initial-repo.test,pull-requests.test,two-clients.test}.ts.
 * Purpose: A Worker wired to the fake GitHub (or the real one), plus session, sandbox token and push-request helpers for the Git tests.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, Session } from '@cloud-swe/protocol';
import type { Request as WorkerRequest } from 'miniflare';

import { concat, FLUSH, pkt } from '../src/git/push.ts';
import { FakeGitHub } from './github-fake.ts';
import { modelAnswer } from './model-answer.ts';
import { type Call, callApi, type Json, model, runEnded, sandboxFile, waitFor } from './rig.ts';
import { forwardOutbound, runtime } from './runtime.ts';

/**
 * One Worker with a GitHub, a scripted model and the real Docker sandbox. `calls` holds one tool round per model turn.
 * The GitHub is the fake, or the real one's App settings with `forwardOutbound` as its handler.
 */
export async function gitWorker(
  fake: Pick<FakeGitHub, 'appSettings' | 'handle'>,
  port: number,
  calls: Call[][] = [],
  bodies: string[] = [],
  settings: Record<string, string> = {},
) {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-git-'));

  const start = () =>
    runtime(storage, {
      bindings: {
        MODEL_ID: model.id,
        ANTHROPIC_API_KEY: 'fake-key',
        PUBLIC_URL: `http://${hostname()}:${port}`,
        ...fake.appSettings,
        ...settings,
      },
      dev: {
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
      listen: { host: '0.0.0.0', port },
    });

  let mf = start();
  const base = await mf.ready;

  const api = (path: string, method?: string, body?: Json) => callApi(base, path, method, body);

  return {
    get mf() {
      return mf;
    },
    base,
    api,
    storage,
    /** Stops the Worker and deletes its storage and the fake GitHub's repositories. */
    close: async () => {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });

      if (fake instanceof FakeGitHub) await rm(fake.root, { recursive: true, force: true });
    },
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

export async function createSession(api: Api, repo?: string, template = 'base') {
  const request = {
    operationId: crypto.randomUUID(),
    template,
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
  return waitFor(() => getSession(api, sessionId), runEnded);
}

/** The capability token the sandbox's Git config sends to the proxy. */
export async function gitToken(workspaceId: string): Promise<string> {
  return /Bearer ([0-9a-f]{64})/.exec((await sandboxFile(workspaceId, '.cloud-swe/git.config')) ?? '')?.[1] ?? '';
}

/** A git-receive-pack request: the commands, the first carrying the capabilities, then the pack. */
export function pushBody(commands: string[], capabilities: string, pack: Uint8Array) {
  const lines = commands.map((command, index) =>
    pkt(new TextEncoder().encode(index === 0 ? `${command}\0${capabilities}` : command)),
  );

  return concat([...lines, FLUSH, pack]);
}
