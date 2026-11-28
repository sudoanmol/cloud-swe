/**
 * Path: server/src/sessions/background.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: The app's side of background commands: reading output, live while the sandbox runs and saved otherwise, and stopping one, at once while the sandbox runs and at its next wake-up while it sleeps.
 */

import type { Session } from '@cloud-swe/protocol';
import { type BackgroundCommand, BackgroundOutput } from '@cloud-swe/protocol/background';

import { catalogStub } from '../env.ts';
import { failure, type Result, success } from '../errors.ts';
import {
  backgroundCommandView,
  backgroundOutput,
  outputSlice,
  readBackground,
  requestStop,
  stopBackground,
} from '../sandbox/background.ts';
import { endCommandsOfDeletedSandbox } from '../sandbox/command-lifecycle.ts';
import { type ToolHost, toolWorkspace } from '../sandbox/host.ts';
import { requireSession } from '../thread-store.ts';

export type BackgroundAction =
  | { kind: 'output'; commandId: string; offset: number }
  | { kind: 'stop'; commandId: string };

async function freshState(host: ToolHost): Promise<Session['workspace']['state']> {
  const session = await requireSession(host.storage);

  return catalogStub(host.env)
    .workspaceState(session.id, session.workspace.id, true)
    .catch(() => 'unreachable' as const);
}

/**
 * The output from `offset`. The state is read fresh: the 15-second cache can still say `running` for a sandbox that
 * just fell asleep, and a read would then wake it, past the sandbox cap.
 */
async function output(host: ToolHost, commandId: string, offset: number, changed: () => void) {
  const before = await readBackground(host.storage, commandId);

  if (!before) return failure('background_command_not_found');
  const state = await freshState(host);
  const workspace = state === 'running' ? await toolWorkspace(host).catch(() => undefined) : undefined;
  const read = await backgroundOutput(host, workspace, commandId);

  if (!read) return failure('background_command_not_found');

  if (read.row.record.kind !== before.record.kind) changed();
  const slice = outputSlice(read.window, read.outputBytes, offset);

  return success(
    BackgroundOutput.parse({
      command: backgroundCommandView(read.row),
      live: read.live,
      offset: slice.offset,
      outputBytes: slice.outputBytes,
      skippedBytes: slice.skippedBytes,
      text: slice.text,
    }),
  );
}

/**
 * Stops a command at the user's request. Ending one that already ended changes nothing. A sleeping sandbox is never
 * woken for it: the command is frozen and costs nothing, so the stop is marked and the first look after the next
 * wake-up carries it out.
 */
async function stop(host: ToolHost, commandId: string, changed: () => void) {
  const row = await readBackground(host.storage, commandId);

  if (!row) return failure('background_command_not_found');

  if (row.endedAt !== null) return success(backgroundCommandView(row));
  const state = await freshState(host);

  if (state === 'deleted') {
    // The sandbox is gone, and the command with it.
    await endCommandsOfDeletedSandbox(host);
    changed();

    return success(backgroundCommandView((await readBackground(host.storage, commandId)) ?? row));
  }

  const workspace = state === 'running' ? await toolWorkspace(host).catch(() => undefined) : undefined;

  const stopped = workspace
    ? await stopBackground(host, workspace, commandId, 'user')
    : await requestStop(host, commandId, 'user');

  changed();

  return success(backgroundCommandView(stopped ?? row));
}

/** One of the app's background command requests. `changed` tells streams and the list row about a state it moved. */
export function backgroundRequest(
  host: ToolHost,
  action: BackgroundAction,
  changed: () => void,
): Promise<Result<BackgroundOutput | BackgroundCommand>> {
  return action.kind === 'output'
    ? output(host, action.commandId, action.offset, changed)
    : stop(host, action.commandId, changed);
}
