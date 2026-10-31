import { err, ExecutionError, type ExecutionEnv, type Shell } from '@earendil-works/pi-durable/env';

import { SandboxFiles } from './files.ts';
import { type ToolHost, toolWorkspace } from './host.ts';
import { remoteFileInfo } from './remote.ts';

class SandboxEnvironment extends SandboxFiles implements ExecutionEnv {
  execute?: Shell['exec'];

  exec: Shell['exec'] = (command, options, context) =>
    this.execute
      ? this.execute(command, options, context)
      : Promise.resolve(err(new ExecutionError('spawn_error', 'Shell requires a native tool invocation')));
}

export async function environment(host: ToolHost, execute?: Shell['exec']): Promise<ExecutionEnv> {
  const workspace = await toolWorkspace(host);
  const root = await remoteFileInfo(host.env, workspace, '.', AbortSignal.timeout(5000));

  if (!root.path.startsWith('/')) throw new Error('Sandbox did not return an absolute working directory');
  const env = new SandboxEnvironment(host.env, workspace, root.path);
  env.execute = execute;

  return env;
}
