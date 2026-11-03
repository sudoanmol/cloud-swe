/**
 * Path: server/test/sandbox.ts
 * Used by: compose.yaml (the sandbox service).
 * Purpose: The Docker sandbox double service, started by compose.yaml, mimicking E2B provisioning and its pause lifecycle.
 */

import { access, constants, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';

import { WorkspaceId } from '@cloud-swe/protocol';

import { DockerTtl, DockerWorkspaceInfo } from '../src/workspaces/docker.ts';
import * as boxes from './sandbox-state.ts';
import { sandboxTools } from './sandbox-tools.ts';

const token = process.env.DOCKER_SANDBOX_TOKEN;

if (!token) throw new Error('DOCKER_SANDBOX_TOKEN required');

// Test double for per-session provisioning: one directory per app workspace, created idempotently.
async function body(request: IncomingMessage) {
  let text = '';

  for await (const chunk of request) text += chunk.toString();

  return text;
}

createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();

    return;
  }

  if (request.method === 'GET' && request.url === '/health') {
    try {
      await access('/workspace', constants.R_OK | constants.W_OK);
      response.writeHead(200).end();
    } catch {
      response.writeHead(503).end();
    }

    return;
  }

  const url = new URL(request.url ?? '/', 'http://sandbox');
  const operation = /^\/workspaces\/([^/]+)\/(file|bytes|info|directory|commands)$/.exec(url.pathname);
  const operationId = WorkspaceId.safeParse(operation?.[1]);

  if (operation && operationId.success) {
    // A paused or starting machine serves nothing. Unlike E2B, a call doesn't resume it.
    if (boxes.stateOf(operationId.data) !== 'running') {
      response.writeHead(boxes.stateOf(operationId.data) === null ? 404 : 409).end();

      return;
    }

    try {
      await sandboxTools(request, response, operationId.data, operation[2] ?? '', url.searchParams);
    } catch {
      response.writeHead(404).end();
    }

    return;
  }

  const lifecycle = /^\/workspaces\/([^/]+)(?:\/(stop|resume|ttl))?$/.exec(url.pathname);
  const id = WorkspaceId.safeParse(lifecycle?.[1]);
  const action = lifecycle?.[2];

  if (!id.success) {
    response.writeHead(404).end();

    return;
  }

  const root = `/workspace/${id.data}`;

  try {
    if (request.method === 'PUT' && !action) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      boxes.create(id.data);
    } else await access(root, constants.R_OK | constants.W_OK);
  } catch {
    response.writeHead(request.method === 'PUT' ? 503 : 404).end();

    return;
  }

  if (boxes.stateOf(id.data) === null) {
    response.writeHead(404).end();

    return;
  }

  // `stop` is for test control; the server only renews, resumes and deletes.
  const ttl = action ? DockerTtl.partial().parse(JSON.parse((await body(request)) || '{}')).ttlSeconds : undefined;

  if (request.method === 'POST' && action === 'stop') boxes.stop(id.data);

  if (request.method === 'POST' && action === 'resume') boxes.resume(id.data, ttl);

  if (request.method === 'POST' && action === 'ttl' && ttl) boxes.renew(id.data, ttl);

  const state = boxes.stateOf(id.data) ?? 'stopped';

  if (request.method === 'DELETE') boxes.remove(id.data);

  response
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify(DockerWorkspaceInfo.parse({ provider: 'docker', id: id.data, state, root })));
}).listen(9000, '0.0.0.0');
