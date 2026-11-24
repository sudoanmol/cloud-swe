/**
 * Path: server/test/rig.ts
 * Used by: server/test/{anthropic-live.test,approvals.test,attachments.test,codemode.test,command-recovery.test,compaction.test,controls.test,conversations.test,credentials.test,delta-stream.test,e2b-live.test,egress.test,environment-delivery.test,environments.test,git-clone-access.test,git-env,git-policy.test,git-proxy.test,github-live.test,initial-repo.test,interaction.test,lifecycle-rig,lifecycle.test,long-response.test,messages.test,model-answer,model-errors.test,network-proxy.test,pull-requests.test,rewind.test,secret-requests.test,session-list.test,sessions.test,tool-events.test,tools.test,transcript.test,two-clients.test}.ts.
 * Purpose: What every Worker test shares: the test account and model, a deadline-based wait that fails loudly, and readers of the sandbox double and stored Threads.
 */

import { readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';

import { CommandIdentity, type Session } from '@cloud-swe/protocol';
import { FileContent, ShellProgress } from '@cloud-swe/protocol/tools';
import type { ToolCall } from '@earendil-works/pi-ai';

import { commandPrefix } from '../src/sandbox/runner.ts';
import { token } from './runtime.ts';
import { DockerCommand } from './sandbox-tools.ts';

/** The model every test session asks for; the scripted answers say the same. */
export const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };

/** The signed-in test account's request headers. */
export const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A signed-in call to the Worker at `base`, with a JSON body when one is given. */
export function callApi(base: URL | string, path: string, method = 'GET', body?: Json) {
  const init: RequestInit = { method, headers };

  if (body !== undefined) init.body = JSON.stringify(body);

  return fetch(new URL(path, base), init);
}

/** A tool call a scripted model answer makes. */
export type Call = Pick<ToolCall, 'id' | 'name' | 'arguments'>;

/** Whether a session's run has reached an end state. */
export const runEnded = (session: Session) => ['completed', 'cancelled', 'failed'].includes(session.run.kind);

/** Polls `read` until `done` accepts its value (by default: until it is defined), and throws on the deadline. */
export function waitFor<T>(
  read: () => Promise<T | undefined> | T | undefined,
  done?: undefined,
  timeoutMs?: number,
): Promise<T>;
export function waitFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs?: number): Promise<T>;
export async function waitFor<T>(
  read: () => Promise<T> | T,
  done?: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await read();

    if (done ? done(value) : value !== undefined) return value;

    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${String(done ?? read)}`);
    await setTimeout(25);
  }
}

const sandboxUrl = (workspaceId: string, route: string) =>
  new URL(`/workspaces/${workspaceId}/${route}`, process.env.DOCKER_SANDBOX_URL ?? 'http://sandbox:9000');

/** A file in the Docker sandbox double, read past the Worker; undefined when it can't be read. */
export async function sandboxFile(workspaceId: string, path: string): Promise<string | undefined> {
  const response = await fetch(sandboxUrl(workspaceId, 'file?path=' + encodeURIComponent(path)), {
    headers: { Authorization: `Bearer ${process.env.DOCKER_SANDBOX_TOKEN ?? ''}` },
  });

  return response.ok ? FileContent.parse(await response.json()).content : undefined;
}

/** The workspace and operation a supervisor command sent to the Docker double's /commands route runs for. */
export function commandIdentity(body: string) {
  const { command } = DockerCommand.parse(JSON.parse(body));

  return CommandIdentity.parse({
    workspaceId: /"workspaceId":"([a-f0-9-]+)"/.exec(command)?.[1],
    operationId: /"operationId":"([a-f0-9-]+)"/.exec(command)?.[1],
  });
}

/** The supervisor's progress file for a command, or undefined before it exists. */
export async function commandProgress(
  identity: ReturnType<typeof CommandIdentity.parse>,
): Promise<ShellProgress | undefined> {
  const text = await sandboxFile(identity.workspaceId, commandPrefix(identity) + '.json');

  return text === undefined ? undefined : ShellProgress.parse(JSON.parse(text));
}

/** Runs a script in the session's sandbox (outside any Pi tool) and returns its output and exit code. */
export async function sandboxRun(workspaceId: string, script: string, timeoutMs = 30_000) {
  const name = crypto.randomUUID();
  const command = `( ${script} ) > .${name}.out 2>&1; echo $? > .${name}.rc`;

  const started = await fetch(sandboxUrl(workspaceId, 'commands'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DOCKER_SANDBOX_TOKEN ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ command }),
  });

  if (!started.ok) throw new Error('Sandbox command failed to start');
  const code = await waitFor(() => sandboxFile(workspaceId, `.${name}.rc`), undefined, timeoutMs);

  return { code: Number.parseInt(code, 10), output: (await sandboxFile(workspaceId, `.${name}.out`)) ?? '' };
}

/** The SQLite files of every Session Thread a stopped or running Worker persisted under `storage`. */
export async function threadDatabases(storage: string): Promise<string[]> {
  const files = await readdir(storage, { recursive: true });

  return files
    .filter((name) => name.endsWith('.sqlite') && name.includes('SessionThreadV2'))
    .map((name) => join(storage, name));
}

/** Everything every Session Thread stores, as text: each table of each database, KV included, with blobs as raw bytes. */
export async function storedText(storage: string): Promise<string> {
  const parts: string[] = [];
  const databases = await threadDatabases(storage);

  if (databases.length === 0) throw new Error('No Session Thread database under ' + storage);

  for (const path of databases) {
    const database = new DatabaseSync(path, { readOnly: true });

    try {
      const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();

      for (const { name } of tables) {
        const rows = database.prepare(`SELECT * FROM "${String(name)}"`);
        rows.setReadBigInts(true);

        for (const row of rows.all()) {
          for (const value of Object.values(row)) {
            parts.push(value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : String(value));
          }
        }
      }
    } finally {
      database.close();
    }
  }

  return parts.join('\n');
}

/** A raw HTTP call, so hop-by-hop headers and the body's last bytes are under the test's control. */
export function raw(base: URL, path: string, headers: Record<string, string>, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
    (resolve, reject) => {
      const call = httpRequest(new URL(path, base), { method, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
        );
        response.on('error', reject);
      });

      call.on('error', reject);
      call.end();
    },
  );
}
