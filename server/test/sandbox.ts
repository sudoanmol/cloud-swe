import { createServer } from 'node:http';
import { access, constants } from 'node:fs/promises';
import { DockerWorkspaceInfo } from '@cloud-swe/protocol/workspace';

const token = process.env.DOCKER_SANDBOX_TOKEN;
if (!token) throw new Error('DOCKER_SANDBOX_TOKEN required');
createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  if (request.method !== 'GET' || request.url !== '/workspace') {
    response.writeHead(404).end();
    return;
  }
  try {
    await access('/workspace', constants.R_OK | constants.W_OK);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(
      DockerWorkspaceInfo.parse({ provider: 'docker', state: 'running', root: '/workspace' }),
    ));
  } catch {
    response.writeHead(503).end();
  }
}).listen(9000, '0.0.0.0');
