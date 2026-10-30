import { createRegistry, type ToolRegistration } from '@earendil-works/pi-durable';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';

import { assertResolvedCommands } from './command-state';
import { executeCommand } from './commands';
import { environment } from './environment';
import { type ToolHost, toolWorkspace } from './host';

export function toolRegistry(host: ToolHost) {
  const registry = createRegistry();
  const bash = createBashTool();
  const read = createReadTool();
  const write = createWriteTool();
  const edit = createEditTool();

  const fileLimits =
    ' This cloud adapter supports UTF-8 text files up to 1 MiB; use bounded bash commands for larger files. Image attachments are not enabled.';

  const wrappedBash: typeof bash = {
    ...bash,
    description: bash.description + ' Cloud sandbox default timeout: 30 seconds; maximum: 600 seconds.',
    // Only the application wrapper replays: it reattaches to the saved UUID job, not to the shell command.
    replay: 'safe',
    async execute(args, api, context) {
      const workspace = await toolWorkspace(host);

      const env = await environment(host, (command, options, ctx) =>
        executeCommand(host, workspace, api, command, options, ctx),
      );

      return bash.execute({ ...args, timeout: args.timeout ?? 30 }, { ...api, env }, context);
    },
  };

  registry.install({
    name: 'coding-tools',
    tools: [
      { ...read, description: read.description + fileLimits },
      { ...write, description: write.description + fileLimits },
      { ...edit, description: edit.description + fileLimits },
      wrappedBash,
    ],
    wraps: ['write', 'edit'].map((tool) => ({
      tool,
      wrap: (original: ToolRegistration): ToolRegistration => ({
        ...original,
        async execute(args, api, context) {
          await assertResolvedCommands(host);

          return original.execute(args, api, context);
        },
      }),
    })),
  });

  return registry;
}
