/**
 * Path: server/src/workspaces/provider.ts
 * Used by: server/src/git/clone.ts, server/src/sandbox/{egress,remote,runner}.ts, server/src/workspaces/{docker,e2b}.ts.
 * Purpose: The file and command interface each sandbox provider implements, and the helpers the providers share.
 */

import { Buffer } from 'node:buffer';

import type { RemoteFileInfo } from '@cloud-swe/protocol/tools';
import { FileError } from '@earendil-works/pi-durable/env';

// Platform setup outside the agent's commands, such as the network-secret daemon, runs as root.
export type RemoteUser = 'root' | undefined;

type ExecResult = { exitCode: number; stdout: string };

export interface SandboxApi {
  readText(path: string, signal: AbortSignal): Promise<string>;
  readBase64(path: string, signal: AbortSignal): Promise<string>;
  write(path: string, content: string, signal: AbortSignal, user: RemoteUser): Promise<void>;
  mkdir(path: string, signal: AbortSignal): Promise<void>;
  info(path: string, signal: AbortSignal): Promise<ReturnType<typeof RemoteFileInfo.parse>>;
  dispatch(command: string, signal: AbortSignal): Promise<void>;
  exec(command: string, user: RemoteUser, timeoutMs: number, signal: AbortSignal): Promise<ExecResult>;
}

export async function boundedBytes(body: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) return Buffer.concat(chunks);
      size += chunk.value.byteLength;

      if (size > limit) throw new Error('Sandbox response too large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
}

// Upstream bodies are never surfaced: only the status decides the code.
export function statusError(status: number) {
  if (status === 404) return new FileError('not_found', 'Sandbox request failed');

  return new FileError(status === 400 ? 'invalid' : 'unknown', 'Sandbox request failed');
}

export function quote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}
