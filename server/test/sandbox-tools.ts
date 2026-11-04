/**
 * Path: server/test/sandbox-tools.ts
 * Used by: server/test/sandbox.ts.
 * Purpose: The Docker sandbox double file and command routes.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chown, mkdir, open, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, resolve } from 'node:path';

import { FileBytes, FileContent, RemoteFileInfo } from '@cloud-swe/protocol/tools';

import { DockerCommand, DockerExec, DockerFileWrite, DockerPath } from '../src/workspaces/docker.ts';
import { track } from './sandbox-state.ts';

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

  if (writing) {
    const made = await mkdir(dirname(path), { recursive: true });

    // Each new directory, from the first one created down to the parent.
    for (let dir = dirname(path); made && dir.length >= made.length; dir = dirname(dir)) await own(dir);
  }

  const parent = path === root ? root : await realpath(dirname(path));

  if (parent !== root && !parent.startsWith(root + '/')) throw new Error('Symlink outside workspace');

  return path;
}

// The egress double runs as root, like E2B's control plane, and runs user work as uid 1000, like E2B's `user`. The
// plain double runs as that user already and refuses root operations.
const isRoot = process.getuid?.() === 0;

const USER = { uid: 1000, gid: 1000 };

function spawnAs(user: 'root' | undefined, home: string) {
  if (user === 'root' && !isRoot) throw new Error('Root operations need the egress double');

  const env = { PATH: process.env.PATH, HOME: user === 'root' ? '/root' : home };

  return isRoot && !user ? { env, ...USER } : { env };
}

/** Files the server writes for the user stay the user's, as on E2B. */
async function own(path: string) {
  if (isRoot) await chown(path, USER.uid, USER.gid);
}

/** Runs a short command to its end, like E2B's commands.run. */
async function exec(root: string, input: ReturnType<typeof DockerExec.parse>) {
  const child = spawn('bash', ['-lc', input.command], {
    cwd: input.user === 'root' ? '/' : root,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...spawnAs(input.user, root),
  });

  let stdout = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout = (stdout + chunk).slice(-65_536);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs);

  const exitCode = await new Promise<number>((done) => {
    child.once('error', () => done(127));
    child.once('close', (code) => done(code ?? 137));
  });

  clearTimeout(timer);

  return { exitCode, stdout };
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
    const { command, user } = DockerCommand.parse(JSON.parse(await boundedBody(request)));

    const child = spawn('bash', ['-lc', command], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      // Never inherit the sandbox service's control-plane capability token.
      ...spawnAs(user, root),
    });

    await new Promise<void>((done, fail) => {
      child.once('spawn', done);
      child.once('error', fail);
    });
    child.unref();
    track(id, child.pid);
    response.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ started: true }));

    return;
  }

  if (route === 'exec' && request.method === 'POST') {
    const result = await exec(root, DockerExec.parse(JSON.parse(await boundedBody(request))));
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));

    return;
  }

  if (route === 'directory' && request.method === 'POST') {
    const input = DockerPath.parse(JSON.parse(await boundedBody(request)));
    const path = await filePath(root, id, input.path, true);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await own(path);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ written: true }));

    return;
  }

  if (route === 'file' && request.method === 'POST') {
    const input = DockerFileWrite.parse(JSON.parse(await boundedBody(request)));
    spawnAs(input.user, root);
    // Root writes platform files outside the workspace, such as /etc/cloud-swe.
    const path = input.user === 'root' ? resolve('/', input.path) : await filePath(root, id, input.path, true);

    if (input.user === 'root') await mkdir(dirname(path), { recursive: true });
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW);

    try {
      await file.writeFile(input.content);
    } finally {
      await file.close();
    }

    if (!input.user) await own(path);

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
      const bytes = Buffer.alloc(5_242_881);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);

      if (bytesRead > 5_242_880) throw new Error('File too large');
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
