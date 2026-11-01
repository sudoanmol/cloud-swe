/**
 * Path: server/src/tools/registry.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Defines the tools Pi can call (read, write, edit, bash, web search/fetch, codemode) and routes bash to the command lifecycle.
 */

import { RemoteCodemodeSandbox } from '@earendil-works/pi-codemode/portable';
import { createRegistry, type ToolRegistration } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';

import { approvalTools } from '../git/approval-tools.ts';
import { pullRequestTools } from '../git/pull-requests.ts';
import { repoTools } from '../git/tools.ts';
import { systemPrompt, toolDescriptions } from '../prompts/index.ts';
import { assertResolvedCommands, interruptCommand } from '../sandbox/command-lifecycle.ts';
import { commandOperations } from '../sandbox/command-records.ts';
import { executeCommand } from '../sandbox/commands.ts';
import { environment } from '../sandbox/environment.ts';
import { type ToolHost, toolWorkspace } from '../sandbox/host.ts';
import { requireSession } from '../thread-store.ts';
import { questionTool } from './questions.ts';
import { todoTool } from './todo.ts';
import { saveWebOutput } from './web-output.ts';
import { webTools } from './web.ts';

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
  // There is no git_push: agents push with git through the proxy.
  registry.install({ name: 'git', tools: [...repoTools(host), ...pullRequestTools(host), ...approvalTools(host)] });

  registry.install({ name: 'interaction', tools: [todoTool, questionTool(host)] });

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
