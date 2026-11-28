/**
 * Path: server/src/tools/background.ts
 * Used by: server/src/tools/registry.ts.
 * Purpose: bash_background, bash_output and bash_stop: the agent starts a command that outlives its turn, reads its output from a byte offset, lists its commands, and stops one.
 */

import { BackgroundCommandId } from '@cloud-swe/protocol/background';
import { ShellInput } from '@cloud-swe/protocol/tools';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { createBashTool } from '@earendil-works/pi-durable/tools';

import {
  backgroundCommandView,
  backgroundOutput,
  listBackground,
  outputSlice,
  refreshOpenBackground,
  startBackground,
  stopBackground,
} from '../sandbox/background.ts';
import { hasUnresolvedCommands } from '../sandbox/command-lifecycle.ts';
import { unresolvedReason } from '../sandbox/command-records.ts';
import { type ToolHost, toolWorkspace } from '../sandbox/host.ts';
import { sandboxRoot } from '../sandbox/remote.ts';
import { commandPrefix } from '../sandbox/runner.ts';
import { text } from '../tool-result.ts';

// What one bash_output call returns at most, as Pi's bash keeps of a command's output.
const READ_BYTES = 50_000;

const START = `Start a bash command in the background, in the current working directory, and return at once with its ID. Use it for anything that keeps running, such as a dev server or a watcher, instead of \`&\`, \`nohup\` or \`setsid\` in bash: those escape stop and are not tracked. The command keeps running after your turn ends; read it with bash_output and stop it with bash_stop. A paused sandbox freezes it and a resumed one continues it. At most 8 run at once. Optionally provide a timeout in seconds.`;

const OUTPUT = `Read a background command's state and output. Give \`offset\` (a byte position in all its output) to read only what came after an earlier read; each answer ends with the next offset. Without \`offset\` it returns the newest output. Without \`id\` it lists the session's background commands, newest first.`;

const STOP = `Stop a background command and its child processes, waiting up to 8 seconds to confirm. Stopping one that already ended changes nothing.`;

const describe = (command: ReturnType<typeof backgroundCommandView>) => {
  switch (command.state) {
    case 'starting':
      return 'starting';
    case 'running':
      return command.stopping ? 'running, stop requested' : 'running';
    case 'exited':
      return command.termination === 'exit'
        ? `exited with code ${command.exitCode}`
        : `${command.termination === 'timeout' ? 'timed out' : `stopped by the ${command.stoppedBy ?? 'system'}`} (code ${command.exitCode})`;
    case 'lost':
      return `lost: ${command.reason}`;
  }
};

const line = (command: ReturnType<typeof backgroundCommandView>) =>
  `${command.id} — ${describe(command)} — started ${command.startedAt} — ${command.command}`;

const idParameter = Type.String({ description: 'The background command ID bash_background returned' });

export function backgroundTools(host: ToolHost) {
  const bash = createBashTool();

  const start = defineTool({
    name: 'bash_background',
    description: START,
    parameters: bash.parameters,
    // The command's ID derives from this call, so a replay finds it and never starts it again.
    replay: 'safe',
    async execute(args, api, context) {
      const workspace = await toolWorkspace(host);

      const input = ShellInput.safeParse({
        command: args.command,
        cwd: api.env?.cwd ?? (await sandboxRoot(host.env, workspace)),
        timeoutSeconds: args.timeout,
      });

      if (!input.success) {
        const [issue] = input.error.issues;

        return text(`Invalid ${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'not accepted'}`, true);
      }

      const started = await startBackground(host, workspace, api, input.data, {
        signal: context.abortSignal,
        blocked: () => hasUnresolvedCommands(host),
      });

      switch (started.kind) {
        case 'limit':
          return text(
            '8 background commands are already running in this session. Stop one with bash_stop first.',
            true,
          );
        case 'blocked':
          return text(unresolvedReason, true);
        case 'not_started':
          return text('The command was not started.', true);
        case 'started':
        case 'replayed':
          break;
      }

      const command = backgroundCommandView(started.row);
      const output = 'output' in started.row.record ? started.row.record.output : '';

      return text(
        `Background command ${command.id}: ${describe(command)}.${output ? `\nOutput so far:\n${output}` : ''}\nRead it with bash_output and stop it with bash_stop.`,
      );
    },
  });

  const output = defineTool({
    name: 'bash_output',
    description: OUTPUT,
    parameters: Type.Object({
      id: Type.Optional(idParameter),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Read from this byte of the output' })),
    }),
    replay: 'safe',
    async execute(args) {
      if (args.id === undefined) {
        // The sandbox runs during a tool call, so the list is current; a failed refresh lists what was last seen.
        await refreshOpenBackground(host, await toolWorkspace(host)).catch(() => false);
        const rows = await listBackground(host.storage);

        return text(
          rows.length === 0
            ? 'No background commands.'
            : rows.map((row) => line(backgroundCommandView(row))).join('\n'),
        );
      }

      const id = BackgroundCommandId.safeParse(args.id);
      const read = id.success ? await backgroundOutput(host, await toolWorkspace(host), id.data) : undefined;

      if (!read) return text(`No background command has the ID ${args.id}.`, true);
      const { offset = Math.max(0, read.outputBytes - READ_BYTES) } = args;
      const slice = outputSlice(read.window, read.outputBytes, offset, READ_BYTES);
      const command = backgroundCommandView(read.row);

      const skipped =
        slice.skippedBytes > 0
          ? ` The ${slice.skippedBytes} bytes before it are no longer kept here; the full log is ${commandPrefix(read.row.record.identity)}.log.`
          : '';

      return text(
        `${command.id}: ${describe(command)}. Output bytes ${slice.offset}–${slice.end} of ${slice.outputBytes}.${skipped}\n${slice.text}\nNext offset: ${slice.end}`,
      );
    },
  });

  const stop = defineTool({
    name: 'bash_stop',
    description: STOP,
    parameters: Type.Object({ id: idParameter }),
    replay: 'safe',
    async execute(args) {
      const id = BackgroundCommandId.safeParse(args.id);
      const row = id.success ? await stopBackground(host, await toolWorkspace(host), id.data, 'agent') : undefined;

      if (!row) return text(`No background command has the ID ${args.id}.`, true);

      return text(`${row.id}: ${describe(backgroundCommandView(row))}.`);
    },
  });

  return [start, output, stop];
}
