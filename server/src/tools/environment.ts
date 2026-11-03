/**
 * Path: server/src/tools/environment.ts
 * Used by: server/src/tools/registry.ts.
 * Purpose: set_environment_variable, the agent's edit of a normal variable in the session's environment, and the prompt section naming what the environment holds. Never touches network secrets.
 */

import { ENVIRONMENT_LIMITS, SecretName, VariableValue } from '@cloud-swe/protocol/environments';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';

import { credentialsStub } from '../env.ts';
import { renderMessage } from '../errors.ts';
import { deterministicUuid } from '../git/ids.ts';
import { text } from '../git/tools.ts';
import { environmentPrompt } from '../prompts/index.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { requireSession } from '../thread-store.ts';

const DESCRIPTION = `Set or remove a normal variable in this session's environment. It is shared with the user and with every session that uses the environment, and it reaches commands started after this call; a process that is already running, such as a dev server, keeps its old value until restarted. Omit value or pass null to remove it. Values are visible to the user and the transcript: never store a production secret. Network secrets can't be set here; ask the user for one.`;

const parameters = Type.Object({
  name: Type.String({ description: 'An env var name, such as DATABASE_URL', maxLength: 128 }),
  value: Type.Optional(
    Type.Union([Type.String({ maxLength: ENVIRONMENT_LIMITS.variableBytes }), Type.Null()], {
      description: 'The new value; null or omitted removes the variable',
    }),
  ),
});

export function environmentTool(host: Pick<ToolHost, 'env' | 'storage'>) {
  return defineTool({
    name: 'set_environment_variable',
    description: DESCRIPTION,
    parameters,
    // A receipt written with the change, keyed by this call, makes a replay a no-op that can't undo a newer edit.
    replay: 'safe',
    async execute(args, api) {
      const session = await requireSession(host.storage);

      if (!session.environment) return text(renderMessage('no_environment'), true);
      const name = SecretName.safeParse(args.name);

      if (!name.success) return text(`Invalid name: ${name.error.issues[0]?.message ?? 'not an env var name'}`, true);
      const value = args.value === undefined || args.value === null ? null : VariableValue.safeParse(args.value);

      if (value && !value.success) return text(`Invalid value: ${value.error.issues[0]?.message ?? 'rejected'}`, true);

      const result = await credentialsStub(host.env).setVariable(
        session.environment,
        name.data,
        value ? value.data : null,
        { kind: 'session', sessionId: session.id },
        await deterministicUuid(`environment-variable:${session.id}:${api.callId}`),
      );

      if ('error' in result) return text(renderMessage(result.error), true);

      return text(
        value
          ? `Set ${name.data} in ${session.environment}. Commands started from now on see the new value; running ones keep the old one.`
          : `Removed ${name.data} from ${session.environment}. Commands started from now on won't have it.`,
      );
    },
  });
}

/** The prompt section for the session's environment, or none without one. */
export async function environmentSection(host: Pick<ToolHost, 'env' | 'storage'>): Promise<string | undefined> {
  const { environment } = await requireSession(host.storage);

  if (!environment) return undefined;
  const { variables, networkSecrets } = await credentialsStub(host.env).promptView(environment);

  return environmentPrompt(environment, variables, networkSecrets);
}
