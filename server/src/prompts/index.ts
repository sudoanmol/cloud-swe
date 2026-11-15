/**
 * Path: server/src/prompts/index.ts
 * Used by: server/src/tools/registry.ts.
 * Purpose: The system prompt sections and built-in tool descriptions. The prose lives in Markdown so it can be read and iterated on directly.
 */

import { credentialsStub } from '../env.ts';
import { branchSuffix } from '../git/push.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { requireSession } from '../thread-store.ts';
import environmentNotes from './environment.md';
import system from './system.md';
import bash from './tools/bash.md';
import edit from './tools/edit.md';
import read from './tools/read.md';
import write from './tools/write.md';

export const toolDescriptions = {
  bash: bash.trim(),
  edit: edit.trim(),
  read: read.trim(),
  write: write.trim(),
};

/** The session's environment, by name only: values never enter the prompt. */
async function environmentSection(host: Pick<ToolHost, 'env' | 'storage'>): Promise<string | undefined> {
  const { environment: name } = await requireSession(host.storage);

  if (!name) return undefined;
  const { variables, networkSecrets } = await credentialsStub(host.env).promptView(name);

  const lines = [
    `This session uses the environment \`${name}\`. Its values are env vars in commands you start; set or remove a normal variable with \`set_environment_variable\`, which applies to commands started after it.`,
    `Normal variables: ${variables.length > 0 ? variables.map((variable) => `\`${variable}\``).join(', ') : 'none'}.`,
  ];

  if (networkSecrets.length === 0) return lines.join('\n');

  const secrets = networkSecrets.map((secret) => `- \`${secret.name}\`: ${secret.hosts.join(', ')}`);

  return [...lines, 'Network secrets and the hosts they work for:', ...secrets, '', environmentNotes.trim()].join('\n');
}

/** Both are re-rendered before each request, so an edit to the session's environment shows on the next one. */
export const promptSections = (host: Pick<ToolHost, 'env' | 'storage'>) => [
  {
    key: 'cloud-swe',
    render: async () =>
      system.trim().replaceAll('{{SESSION_SHORT_ID}}', branchSuffix((await requireSession(host.storage)).id)),
  },
  { key: 'environment', render: () => environmentSection(host) },
];
