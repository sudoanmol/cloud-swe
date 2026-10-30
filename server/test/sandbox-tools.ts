import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, resolve } from 'node:path';

import { FileBytes, FileContent, RemoteFileInfo } from '@cloud-swe/protocol/tools';

import { DockerCommand, DockerFileWrite, DockerPath } from '../src/workspaces/docker-schemas.ts';

async function boundedBody(request: IncomingMessage): Promise<string> {
  let text = '';

  for await (const chunk of request) {
    text += chunk.toString();

    if (Buffer.byteLength(text) > 7_000_000) throw new Error('Body too large');
  }

  return text;
}

async function filePath(root: string, id: string, input: string, writing = false) {
  if (input.startsWith('/tmp/cloud-swe-' + id + '-')) {
    if (input.split('/').includes('..') || input.includes('\0')) throw new Error('Invalid temporary path');

    return input;
  }

  const path = resolve(root, input);

  if (path !== root && !path.startsWith(root + '/')) throw new Error('Path outside workspace');

  if (writing) await mkdir(dirname(path), { recursive: true });
  const parent = path === root ? root : await realpath(dirname(path));

  if (parent !== root && !parent.startsWith(root + '/')) throw new Error('Symlink outside workspace');

  return path;
}

export async function sandboxTools(
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
  route: string,
  search: URLSearchParams,
): Promise<void> {
  const root = '/workspace/' + id;
  await stat(root);

  if (route === 'commands' && request.method === 'POST') {
    const { command } = DockerCommand.parse(JSON.parse(await boundedBody(request)));

    const child = spawn('bash', ['-lc', command], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      // Never inherit the sandbox service's control-plane capability token.
      env: { PATH: process.env.PATH, HOME: root },
    });

    await new Promise<void>((done, fail) => {
      child.once('spawn', done);
      child.once('error', fail);
    });
    child.unref();
    response.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ started: true }));

    return;
  }

  if (route === 'directory' && request.method === 'POST') {
    const input = DockerPath.parse(JSON.parse(await boundedBody(request)));
    const path = await filePath(root, id, input.path, true);
    await mkdir(path, { recursive: true, mode: 0o700 });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ written: true }));

    return;
  }

  if (route === 'file' && request.method === 'POST') {
    const input = DockerFileWrite.parse(JSON.parse(await boundedBody(request)));
    const path = await filePath(root, id, input.path, true);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW);

    try {
      await file.writeFile(input.content);
    } finally {
      await file.close();
    }

    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ written: true }));

    return;
  }

  const path = await filePath(root, id, search.get('path') ?? '.');

  if (route === 'info' && request.method === 'GET') {
    const file = await stat(path);

    const body = RemoteFileInfo.parse({
      name: basename(path),
      path,
      kind: file.isDirectory() ? 'directory' : 'file',
      size: file.size,
      mtimeMs: file.mtimeMs,
    });

    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

    return;
  }

  if (route === 'bytes' && request.method === 'GET') {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const bytes = Buffer.alloc(1_048_577);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);

      if (bytesRead > 1_048_576) throw new Error('File too large');
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify(
            FileBytes.parse({ content: bytes.subarray(0, bytesRead).toString('base64'), encoding: 'base64' }),
          ),
        );
    } finally {
      await file.close();
    }

    return;
  }

  if (route === 'file' && request.method === 'GET') {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const bytes = Buffer.alloc(400_001);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);

      if (bytesRead > 400_000) throw new Error('File too large');
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(FileContent.parse({ content: bytes.subarray(0, bytesRead).toString('utf8') })));
    } finally {
      await file.close();
    }

    return;
  }

  response.writeHead(404).end();
}
