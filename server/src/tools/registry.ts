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
import { systemPrompt, toolDescriptions } from '../prompts';
import { requireSession } from '../sessions/thread-store';
import { commandOperations } from './command-records';
import { assertResolvedCommands } from './command-state';
import { executeCommand } from './commands';
import { environment } from './environment';
import { type ToolHost, toolWorkspace } from './host';
import { interruptCommand } from './interrupt';
import { webTools } from './web';
import { saveWebOutput } from './web-output';

export function toolRegistry(host: ToolHost) {
  const registry = createRegistry();

  registry.install({
    name: 'cloud-swe',
    sections: [
      {
        key: 'cloud-swe',
        render: async () => systemPrompt((await requireSession(host.storage)).id.slice(0, 8)),
      },
    ],
  });
  const bash = createBashTool();
  const read = createReadTool();
  const write = createWriteTool();
  const edit = createEditTool();

  const wrappedBash: typeof bash = {
    ...bash,
    description: toolDescriptions.bash,
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
      { ...read, description: toolDescriptions.read },
      { ...write, description: toolDescriptions.write },
      { ...edit, description: toolDescriptions.edit },
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

  const web = webTools(host.env.FIRECRAWL_API_KEY?.trim(), (callId, text) => saveWebOutput(host, callId, text));

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
