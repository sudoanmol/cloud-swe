/**
 * Path: server/test/lifecycle-rig.ts
 * Used by: server/test/{codemode.test,command-recovery.test,compaction.test,controls.test,credentials.test,environment-delivery.test,event-frames.test,git-clone-access.test,history-arguments.test,interaction.test,lifecycle.test,long-response.test,model-errors.test,queue-full.test,secret-requests.test,tool-events.test,tools.test,transcript.test,web.test}.ts.
 * Purpose: A Worker with an interceptable sandbox and model, for lifecycle tests.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CreateSessionResponse, HistoryResponse, OperationReceipt, Session, Snapshot } from '@cloud-swe/protocol';
import type { AnswerQuestionRequest } from '@cloud-swe/protocol/interaction';
import { type Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';

import { DockerCreate, DockerWorkspaceInfo } from '../src/workspaces/docker.ts';
import { sessionEvents } from './event-stream.ts';
import { modelAnswer } from './model-answer.ts';
import { type Call, headers, model, runEnded, waitFor } from './rig.ts';
import { runtime, type RuntimeOptions } from './runtime.ts';

// `host` and `authorization` let a test answer a fake upstream, such as a network-secret provider.
export type SandboxRequest = { method: string; path: string; body: string; host: string; authorization: string | null };

/** Returning a response replaces the sandbox's own answer; `forward` sends the request on first. */
export type Intercept = (
  request: SandboxRequest,
  forward: () => Promise<globalThis.Response>,
) => globalThis.Response | undefined | Promise<globalThis.Response | undefined>;

/** Answers a model request, given its body. */
export type Answer = (body: string, request: WorkerRequest) => WorkerResponse | Promise<WorkerResponse>;

/**
 * A Worker under test with a scripted model and the Docker sandbox double behind an interceptor.
 * Lifecycle settings go in `settings`; `restart()` reopens the same persisted storage.
 */
export async function lifecycleRig(settings: Record<string, string> = {}) {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-lifecycle-'));
  const bodies: string[] = [];
  const log: SandboxRequest[] = [];
  let next: Call | undefined;
  let answer: Answer | undefined;
  let intercept: Intercept = () => undefined;

  const dev = {
    outboundService: {
      type: 'fetcher',
      handler: async (request) => {
        if (new URL(request.url).hostname === 'api.anthropic.com') {
          const body = await request.text();
          bodies.push(body);

          if (answer) return answer(body, request);
          const call = next;
          next = undefined;

          return modelAnswer(model.id, call ? [call] : []);
        }

        const body = request.method === 'GET' ? '' : await request.text();
        const url = new URL(request.url);

        const entry = {
          method: request.method,
          path: url.pathname,
          body,
          host: url.hostname,
          authorization: request.headers.get('authorization'),
        };

        log.push(entry);

        const forward = () =>
          fetch(request.url, { method: request.method, headers: [...request.headers], body: body || undefined });

        const response = (await intercept(entry, forward)) ?? (await forward());

        return new WorkerResponse(await response.arrayBuffer(), { status: response.status });
      },
    },
  } satisfies NonNullable<RuntimeOptions['dev']>;

  const bindings = { WORKSPACE_BACKEND: 'docker', MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key', ...settings };
  let mf = runtime(storage, { bindings, dev });
  let base = await mf.ready;

  const api = (path: string, body?: Record<string, string | string[]> | AnswerQuestionRequest, method = 'POST') =>
    fetch(new URL(path, base), {
      method: body ? method : 'GET',
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
    setAnswer: (fn: Answer | undefined) => {
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
    /** The Catalog's own ID, as its first sandbox create sent it to the double. */
    catalogId: () =>
      DockerCreate.parse(JSON.parse(rig.requests('PUT', /^\/workspaces\/[^/]+$/)[0]?.body ?? '')).catalogId,
    /** A sandbox made straight in the double, which no workspace entry points to, stamped with `catalogId` if given. */
    unrecordedBox: async (catalogId?: string) => {
      const id = crypto.randomUUID();

      const response = await fetch(new URL(`/workspaces/${id}`, process.env.DOCKER_SANDBOX_URL), {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + process.env.DOCKER_SANDBOX_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogId }),
      });

      assert.equal(response.status, 200);

      return id;
    },
    requests: (method: string, pattern: RegExp) => log.filter((r) => r.method === method && pattern.test(r.path)),
    createResponse: (operationId = crypto.randomUUID(), environment?: string) =>
      fetch(new URL('/v1/sessions', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operationId, template: 'base', model, environment }),
      }),
    create: async (environment?: string) => {
      const response = await rig.createResponse(undefined, environment);
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
    settled: (id: string) => waitFor(() => session(id), runEnded),
    snapshot: async (id: string) => Snapshot.parse(await (await api(`/v1/sessions/${id}/snapshot`)).json()),
    history: async (id: string) =>
      HistoryResponse.parse(await (await api(`/v1/sessions/${id}/history?limit=100`)).json()),
    /** The Worker's base URL, which changes on restart. */
    base: () => base,
    /** The Worker's persistence directory. */
    storage,
    restart: async () => {
      await mf.dispose();
      mf = runtime(storage, { bindings, dev });
      base = await mf.ready;
    },
    close: async () => {
      await mf.dispose();
      await rm(storage, { recursive: true, force: true });
    },
  };

  return rig;
}
