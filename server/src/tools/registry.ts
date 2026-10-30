/**
 * Path: server/src/tools/registry.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Defines the tools Pi can call (read, write, edit, bash, web search/fetch, codemode) and routes bash to the command lifecycle.
 */
import { RemoteCodemodeSandbox } from '@earendil-works/pi-codemode/portable';
import { createRegistry, type ToolRegistration } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';

import { gitTools } from '../git/tools';
import { commandOperations } from './command-records';
import { assertResolvedCommands } from './command-state';
import { executeCommand } from './commands';
import { environment } from './environment';
import { type ToolHost, toolWorkspace } from './host';
import { interruptCommand } from './interrupt';
import { webTools } from './web';

export function toolRegistry(host: ToolHost) {
  const registry = createRegistry();

  registry.install({
    name: 'cloud-swe',
    sections: [
      {
        key: 'sandbox-lifetime',
        render: () =>
          'This sandbox is temporary and is deleted after a period of inactivity. If you changed code that should be kept, commit it, push it and open a pull request before finishing. If the task produces nothing to keep, such as research or a question, put the full answer in your final message and do not open a pull request.',
      },
    ],
  });
  const bash = createBashTool();
  const read = createReadTool();
  const write = createWriteTool();
  const edit = createEditTool();

  const fileLimits =
    ' This cloud adapter supports UTF-8 text files up to 1 MiB; use bounded bash commands for larger files. Image attachments are not enabled.';

  const wrappedBash: typeof bash = {
    ...bash,
    description:
      bash.description +
      " Cloud sandbox: there is no default timeout, so a command runs until it exits; set `timeout` to bound it. Redirect a background process's output to a file; a process still writing to the tool's output is cut off when the command ends.",
    // Only the application wrapper replays: it reattaches to the saved UUID job, not to the shell command.
    replay: 'safe',
    async execute(args, api, context) {
      const workspace = await toolWorkspace(host);

      const env = await environment(host, (command, options, ctx) =>
        executeCommand(host, workspace, api, command, options, ctx),
      );

      return bash.execute(args, { ...api, env }, context);
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

  const web = webTools(host.env.FIRECRAWL_API_KEY?.trim());

  if (web.length > 0) registry.install({ name: 'web-tools', tools: web });
  registry.install({ name: 'git', tools: gitTools(host) });

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
