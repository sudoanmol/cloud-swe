/**
 * Path: server/test/rig.ts
 * Used by: server/test/{approvals.test,codemode.test,command-recovery.test,compaction.test,controls.test,credentials.test,egress.test,environment-delivery.test,git-clone-access.test,git-env,git-policy.test,git-proxy.test,history-arguments.test,initial-repo.test,interaction.test,lifecycle-rig,lifecycle.test,long-response.test,messages.test,model-errors.test,network-proxy.test,secret-requests.test,tools.test,two-clients.test}.ts.
 * Purpose: What every Worker test shares: a deadline-based wait that fails loudly.
 */

import { setTimeout } from 'node:timers/promises';

import { CommandIdentity } from '@cloud-swe/protocol';
import { FileContent, ShellProgress } from '@cloud-swe/protocol/tools';

import { commandPrefix } from '../src/sandbox/runner.ts';
import { DockerCommand } from './sandbox-tools.ts';

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
