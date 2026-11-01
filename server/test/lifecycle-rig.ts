/**
 * Path: server/test/lifecycle-rig.ts
 * Used by: server/test/{interaction.test,lifecycle.test,long-response.test,queue-full.test,web.test}.ts.
 * Purpose: A Worker with an interceptable sandbox and model, for lifecycle tests.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, HistoryResponse, OperationReceipt, Session, Snapshot } from '@cloud-swe/protocol';
import type { AnswerQuestionRequest } from '@cloud-swe/protocol/interaction';
import type { ToolCall } from '@earendil-works/pi-ai';
import { Response as WorkerResponse } from 'miniflare';

import { DockerWorkspaceInfo } from '../src/workspaces/docker.ts';
import { sessionEvents } from './event-stream.ts';
import { modelAnswer } from './model-answer.ts';
import { runtime } from './runtime.ts';

const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };
const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };

type Call = Pick<ToolCall, 'id' | 'name' | 'arguments'>;

export type SandboxRequest = { method: string; path: string; body: string };

/** Returning a response replaces the sandbox's own answer. */
export type Intercept = (
  request: SandboxRequest,
) => globalThis.Response | undefined | Promise<globalThis.Response | undefined>;

/**
 * A Worker under test with a scripted model and the Docker sandbox double behind an interceptor.
 * Lifecycle settings go in `settings`; `restart()` reopens the same persisted storage.
 */
export async function lifecycleRig(settings: Record<string, string> = {}) {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-lifecycle-'));
  const bodies: string[] = [];
  const log: SandboxRequest[] = [];
  let next: Call | undefined;
  let answer: (() => WorkerResponse) | undefined;
  let intercept: Intercept = () => undefined;

  const dev = {
    outboundService: {
      type: 'fetcher',
      handler: async (request) => {
        if (new URL(request.url).hostname === 'api.anthropic.com') {
          bodies.push(await request.text());

          if (answer) return answer();
          const call = next;
          next = undefined;

          return modelAnswer(model.id, call ? [call] : []);
        }

        const body = request.method === 'GET' ? '' : await request.text();
        const entry = { method: request.method, path: new URL(request.url).pathname, body };
        log.push(entry);
        const replaced = await intercept(entry);

        if (replaced) return new WorkerResponse(await replaced.arrayBuffer(), { status: replaced.status });

        const response = await fetch(request.url, {
          method: request.method,
          headers: [...request.headers],
          body: body || undefined,
        });

        return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
      },
    },
  } satisfies NonNullable<Parameters<typeof runtime>[2]>;

  const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key', ...settings };
  let mf = runtime(storage, bindings, dev);
  let base = await mf.ready;

  const api = (path: string, body?: Record<string, string> | AnswerQuestionRequest) =>
    fetch(new URL(path, base), {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

  const sandbox = (id: string, action: string, body?: string) =>
    fetch(new URL(`/workspaces/${id}${action}`, process.env.DOCKER_SANDBOX_URL), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + process.env.DOCKER_SANDBOX_TOKEN, 'Content-Type': 'application/json' },
      body,
    });

  const session = async (id: string) => Session.parse(await (await api(`/v1/sessions/${id}`)).json());

  const rig = {
    bodies,
    log,
    api,
    session,
    sandbox,
    events: (id: string) => sessionEvents(new URL(`/v1/sessions/${id}/events`, base), headers),
    /** Replaces the scripted model's answers until cleared. */
    setAnswer: (fn: (() => WorkerResponse) | undefined) => {
      answer = fn;
    },
    setIntercept: (fn: Intercept) => {
      intercept = fn;
    },
    /** The sandbox double's own view: its state, or `deleted` for a 404. */
    boxState: async (id: string) => {
      const response = await sandbox(id, '');

      return response.status === 404 ? 'deleted' : DockerWorkspaceInfo.parse(await response.json()).state;
    },
    requests: (method: string, pattern: RegExp) => log.filter((r) => r.method === method && pattern.test(r.path)),
    createResponse: (operationId = crypto.randomUUID()) =>
      fetch(new URL('/v1/sessions', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operationId, environment: 'base', model }),
      }),
    create: async () => {
      const response = await rig.createResponse();
      assert.equal(response.status, 201, await response.clone().text());

      return CreateSessionResponse.parse(await response.json()).session;
    },
    send: (id: string, text: string, operationId = crypto.randomUUID(), call?: Call) => {
      next = call;

      return api(`/v1/sessions/${id}/messages`, { operationId, text });
    },
    bash: (command: string): Call => ({ id: crypto.randomUUID(), name: 'bash', arguments: { command } }),
    accepted: async (response: globalThis.Response) => {
      assert.equal(response.status, 202, await response.clone().text());

      return OperationReceipt.parse(await response.json());
    },
    settled: async (id: string) => {
      for (let attempt = 0; attempt < 1500; attempt++) {
        const current = await session(id);

        if (['completed', 'cancelled', 'failed'].includes(current.run.kind)) return current;
        await setTimeout(20);
      }

      throw new Error('Run did not settle');
    },
    until: async <T>(read: () => Promise<T>, done: (value: T) => boolean, attempts = 400) => {
      let value = await read();

      for (let attempt = 0; attempt < attempts && !done(value); attempt++) {
        await setTimeout(25);
        value = await read();
      }

      return value;
    },
    snapshot: async (id: string) => Snapshot.parse(await (await api(`/v1/sessions/${id}/snapshot`)).json()),
    history: async (id: string) =>
      HistoryResponse.parse(await (await api(`/v1/sessions/${id}/history?limit=100`)).json()),
    restart: async () => {
      await mf.dispose();
      mf = runtime(storage, bindings, dev);
      base = await mf.ready;
    },
    close: async () => {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    },
  };

  return rig;
}
