import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import type { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import {
  BoatCommandDispatched,
  BoatFileBytes,
  BoatFolderCreated,
  FileBytes,
  BoatFileInfo,
  BoatFileRead,
  BoatFileWritten,
  CommandDispatched,
  FileContent,
  FileWritten,
  RemoteFileInfo,
  SandboxResponse,
} from '@cloud-swe/protocol/tools';
import { FileError } from '@earendil-works/pi-durable/env';

import type { Env } from '../env';
import { boatClient } from '../workspaces/boat';

export type ToolsEnv = Pick<Env, 'BOAT_API_KEY' | 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN'>;

async function boundedJson(response: Response) {
  if (!response.ok) throw new FileError(response.status === 404 ? 'not_found' : 'unknown', 'Sandbox request failed');

  if (!response.body) throw new Error('Sandbox response missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > 2_000_000) throw new Error('Sandbox response too large');
      text += decoder.decode(chunk.value, { stream: true });
    }

    return SandboxResponse.parse(JSON.parse(text + decoder.decode()));
  } finally {
    await reader.cancel();
  }
}

async function docker(
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  route: string,
  signal: AbortSignal,
  body?: { path: string; content?: string } | { command: string },
) {
  if (!env.DOCKER_SANDBOX_URL || !env.DOCKER_SANDBOX_TOKEN) throw new Error('Missing sandbox configuration');
  const url = new URL('/workspaces/' + workspace.sandboxId + route, env.DOCKER_SANDBOX_URL);

  return fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + env.DOCKER_SANDBOX_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

export async function readRemoteFile(
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  if (workspace.provider === 'docker') {
    return FileContent.parse(
      await boundedJson(await docker(env, workspace, '/file?path=' + encodeURIComponent(path), signal)),
    ).content;
  }

  const response = await boatClient(env).readFileRaw(
    { sandboxId: workspace.sandboxId, path, encoding: 'utf8' },
    { signal },
  );

  // Read the raw body: generated SDK deserializers are not boundary validators.
  const body = await boundedJson(response.raw);
  const parsed = BoatFileRead.parse(body);

  return parsed.content;
}

export async function writeRemoteFile(
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  if (new TextEncoder().encode(content).length > 1_048_576) throw new FileError('invalid', 'File exceeds 1 MiB');

  if (workspace.provider === 'docker') {
    FileWritten.parse(await boundedJson(await docker(env, workspace, '/file', signal, { path, content })));

    return;
  }

  await createRemoteDirectory(env, workspace, posix.dirname(path), signal);

  const response = await boatClient(env).writeFileRaw(
    {
      sandboxId: workspace.sandboxId,
      fileWriteRequest: { path, content, encoding: 'utf8' },
    },
    { signal },
  );

  BoatFileWritten.parse(await boundedJson(response.raw));
}

export async function dispatchRemoteCommand(
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  command: string,
  signal: AbortSignal,
): Promise<void> {
  if (workspace.provider === 'docker') {
    CommandDispatched.parse(await boundedJson(await docker(env, workspace, '/commands', signal, { command })));

    return;
  }

  const response = await boatClient(env).commandRaw(
    {
      sandboxId: workspace.sandboxId,
      commandRequest: { command, detached: true },
    },
    { signal },
  );

  BoatCommandDispatched.parse(await boundedJson(response.raw));
}

function decodeFile(content: string): Uint8Array {
  const bytes = Buffer.from(content, 'base64');

  if (bytes.length > 1_048_576 || bytes.toString('base64') !== content)
    throw new FileError('invalid', 'Invalid or oversized sandbox file');

  return bytes;
}

export async function readRemoteBytes(
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  path: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (workspace.provider === 'docker') {
    const body = FileBytes.parse(
      await boundedJson(await docker(env, workspace, '/bytes?path=' + encodeURIComponent(path), signal)),
    );

    return decodeFile(body.content);
  }

  const response = await boatClient(env).readFileRaw(
    { sandboxId: workspace.sandboxId, path, encoding: 'base64' },
    { signal },
  );

  const body = BoatFileBytes.parse(await boundedJson(response.raw));

  return decodeFile(body.content);
}

export async function createRemoteDirectory(
  env: ToolsEnv,
  workspace: WorkspaceRecord,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  if (workspace.provider === 'docker') {
    FileWritten.parse(await boundedJson(await docker(env, workspace, '/directory', signal, { path })));

    return;
  }

  const response = await boatClient(env).createFolderRaw(
    {
      sandboxId: workspace.sandboxId,
      fileFolderRequest: { path, mode: '700' },
    },
    { signal },
  );

  BoatFolderCreated.parse(await boundedJson(response.raw));
}

export async function remoteFileInfo(env: ToolsEnv, workspace: WorkspaceRecord, path: string, signal: AbortSignal) {
  if (workspace.provider === 'docker') {
    return RemoteFileInfo.parse(
      await boundedJson(await docker(env, workspace, '/info?path=' + encodeURIComponent(path), signal)),
    );
  }

  const response = await boatClient(env).getFileInfoRaw({ sandboxId: workspace.sandboxId, path }, { signal });
  const file = BoatFileInfo.parse(await boundedJson(response.raw));

  return RemoteFileInfo.parse({
    path: file.path,
    name: file.name,
    size: file.size,
    mtimeMs: Date.parse(file.modifiedAt),
    kind: file.isSymlink ? 'symlink' : file.isDir ? 'directory' : 'file',
  });
}
