import { access, constants, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';

import { WorkspaceId } from '@cloud-swe/protocol';
import { DockerWorkspaceInfo } from '@cloud-swe/protocol/workspace';

const token = process.env.DOCKER_SANDBOX_TOKEN;

if (!token) throw new Error('DOCKER_SANDBOX_TOKEN required');

const workspaceRoute = /^\/workspaces\/([^/]+)$/;

// Test double for per-session provisioning: one directory per app workspace, created idempotently.
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

  const id = WorkspaceId.safeParse(workspaceRoute.exec(request.url ?? '')?.[1]);

  if (!id.success || (request.method !== 'GET' && request.method !== 'PUT')) {
    response.writeHead(404).end();

    return;
  }

  const root = `/workspace/${id.data}`;

  try {
    if (request.method === 'PUT') await mkdir(root, { recursive: true, mode: 0o700 });
    else await access(root, constants.R_OK | constants.W_OK);
  } catch {
    response.writeHead(request.method === 'PUT' ? 503 : 404).end();

    return;
  }

  response
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify(DockerWorkspaceInfo.parse({ provider: 'docker', id: id.data, state: 'running', root })));
}).listen(9000, '0.0.0.0');
