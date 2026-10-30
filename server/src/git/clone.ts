/**
 * Path: server/src/git/clone.ts
 * Used by: server/src/git/{tools,initial-repo}.ts.
 * Purpose: Builds the sandbox shell script that clones a registered repo and sets the checkout's Git identity.
 */
import type { GitIdentity } from '@cloud-swe/protocol/credentials';

import { quote } from '../tools/runner.ts';

type CloneInput = {
  url: string;
  path: string;
  branch?: string;
  configPath: string;
  identity?: GitIdentity;
};

/**
 * Everything is single-quoted and inputs are already validated by the protocol schemas. The global include makes
 * every later `git fetch` and `git push` in the sandbox use the session's proxy for github.com.
 * Cloning is skipped when the checkout exists, so a replay or a retry is harmless.
 */
export function cloneScript(input: CloneInput): string {
  const path = quote(input.path);

  return [
    'set -e',
    `git config --global --replace-all include.path ${quote(input.configPath)}`,
    `if [ ! -d ${path}/.git ]; then`,
    `  GIT_TERMINAL_PROMPT=0 git clone${input.branch ? ' --branch ' + quote(input.branch) : ''} -- ${quote(input.url)} ${path}`,
    'fi',
    ...(input.identity
      ? [
          `git -C ${path} config user.name ${quote(input.identity.name)}`,
          `git -C ${path} config user.email ${quote(input.identity.email)}`,
        ]
      : []),
  ].join('\n');
}
