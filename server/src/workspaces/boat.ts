import { BoatApi, Configuration, ResponseError } from '@boatdev/sdk';
import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { BoatApiError, BoatSandboxCreated, BoatSandboxList, BoatWorkspaceInfo } from '@cloud-swe/protocol/workspace';
import { Cause, Effect, Schedule } from 'effect';

import type { Env } from '../env';
import { WorkspaceError, workspaceError } from './errors.ts';

type BoatEnv = Pick<Env, 'BOAT_API_KEY'>;

function client(env: BoatEnv): BoatApi {
  if (!env.BOAT_API_KEY) throw new WorkspaceError({ reason: 'configuration' });

  // Use the Worker's fetch rather than the SDK's Node HTTP/2 transport.
  return new BoatApi(new Configuration({ accessToken: env.BOAT_API_KEY, fetchApi: fetch }));
}

function isInProgress(failure: Cause.UnknownError | Cause.TimeoutError): Effect.Effect<boolean> {
  const error = failure.cause;

  if (!(error instanceof ResponseError) || error.response.status !== 409) return Effect.succeed(false);

  return Effect.tryPromise(() => error.response.json()).pipe(
    Effect.map((body) => {
      const parsed = BoatApiError.safeParse(body);

      return parsed.success && parsed.data.error.code === 'idempotency_in_progress';
    }),
    Effect.orElseSucceed(() => false),
  );
}

export function createBoatSandbox(env: BoatEnv, creation: SessionCreation): Effect.Effect<string, WorkspaceError> {
  return Effect.tryPromise((signal) =>
    client(env).create(
      {
        // Boat returns the same sandbox for a retried operation instead of a second billable one.
        idempotencyKey: creation.request.operationId,
        createSandboxRequest: {
          environment: creation.request.environment,
          name: `cloud-swe-${creation.workspaceId}`,
          type: 'default',
        },
      },
      { signal },
    ),
  ).pipe(
    Effect.timeout('30 seconds'),
    Effect.retry({ times: 9, schedule: Schedule.spaced('1 second'), while: isInProgress }),
    Effect.timeout('2 minutes'),
    Effect.mapError(workspaceError),
    Effect.flatMap((created) =>
      Effect.try({
        try: () => BoatSandboxCreated.parse(created).sandbox.id,
        catch: () => new WorkspaceError({ reason: 'invalid_response' }),
      }),
    ),
  );
}

export async function findBoatSandbox(
  env: BoatEnv,
  creation: SessionCreation,
  signal: AbortSignal,
): Promise<string | null> {
  const name = `cloud-swe-${creation.workspaceId}`;
  const parsed = BoatSandboxList.safeParse(await client(env).sandboxes({ namePrefix: name, limit: 2 }, { signal }));

  if (!parsed.success) throw new WorkspaceError({ reason: 'invalid_response' });

  // Never guess which sandbox belongs to an intent, or treat a truncated result as absence.
  if (parsed.data.pageInfo.hasMore) throw new WorkspaceError({ reason: 'uncertain' });
  const matches = parsed.data.sandboxes.filter((sandbox) => sandbox.name === name);

  if (matches.length > 1) throw new WorkspaceError({ reason: 'uncertain' });

  return matches[0]?.id ?? null;
}

export async function inspectBoatSandbox(
  env: BoatEnv,
  sandboxId: string,
  signal: AbortSignal,
): Promise<Session['workspace']['state']> {
  const parsed = BoatWorkspaceInfo.safeParse(await client(env).get({ sandboxId }, { signal }));

  if (!parsed.success) throw new WorkspaceError({ reason: 'invalid_response' });
  const { sandbox } = parsed.data;

  if (sandbox.id !== sandboxId || sandbox.access === 'view') {
    throw new WorkspaceError({ reason: 'invalid_response' });
  }

  if (sandbox.health === 'degraded') return 'unreachable';

  switch (sandbox.state) {
    case 'ready':
    case 'idle':
    case 'running':
      return 'running';
    case 'init':
    case 'provisioning':
    case 'provisioned':
    case 'cloning':
      return 'starting';
    case 'archiving':
    case 'archived':
      return 'stopped';
    case 'error':
    case 'cancelled':
      return 'error';
    default: {
      const exhaustive: never = sandbox.state;

      return exhaustive;
    }
  }
}
