import { RemoteCodemodeSandbox } from '@earendil-works/pi-codemode/portable';
import { createRegistry, type ToolRegistration } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';

import { commandOperations } from './command-records';
import { assertResolvedCommands } from './command-state';
import { executeCommand } from './commands';
import { environment } from './environment';
import { type ToolHost, toolWorkspace } from './host';
import { interruptCommand } from './interrupt';

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

  const codemode = createCodemodeExtension({
    sandbox: new RemoteCodemodeSandbox({
      remote: () => host.env.CODEMODE.get(host.env.CODEMODE.newUniqueId()),
      memoryLimitBytes: 32 * 1024 * 1024,
    }),
    models: false,
  });

  registry.install({
    ...codemode,
    tools: codemode.tools?.map((tool): ToolRegistration => ({
      ...tool,
      async execute(args, api, context) {
        const result = await tool.execute(args, api, context);
        const children = (await commandOperations(host)).filter((op) => op.toolCallId.startsWith(api.callId + '/'));

        if (children.length > 0) {
          const workspace = await toolWorkspace(host);
          const stopped = await Promise.all(children.map((op) => interruptCommand(host, workspace, op)));

          if (!stopped.every(Boolean))
            api.diagnostic({
              severity: 'error',
              code: 'uncertain',
              message: 'A nested remote command could not be confirmed stopped',
            });
        }

        return result;
      },
    })),
  });

  return registry;
}
