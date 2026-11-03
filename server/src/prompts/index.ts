/**
 * Path: server/src/prompts/index.ts
 * Used by: server/src/tools/{environment,registry}.ts.
 * Purpose: The system prompt, the environment section and built-in tool descriptions, kept as Markdown so they can be read and iterated on directly.
 */

import environment from './environment.md';
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

export const systemPrompt = (sessionShortId: string) =>
  system.trim().replaceAll('{{SESSION_SHORT_ID}}', sessionShortId);

/** The session's environment, by name only: values never enter the prompt. */
export function environmentPrompt(
  name: string,
  variables: string[],
  networkSecrets: { name: string; hosts: string[] }[],
): string {
  const lines = [
    `This session uses the environment \`${name}\`. Its values are env vars in commands you start; set or remove a normal variable with \`set_environment_variable\`, which applies to commands started after it.`,
    `Normal variables: ${variables.length > 0 ? variables.map((variable) => `\`${variable}\``).join(', ') : 'none'}.`,
  ];

  if (networkSecrets.length === 0) return lines.join('\n');

  const secrets = networkSecrets.map((secret) => `- \`${secret.name}\`: ${secret.hosts.join(', ')}`);

  return [...lines, 'Network secrets and the hosts they work for:', ...secrets, '', environment.trim()].join('\n');
}
