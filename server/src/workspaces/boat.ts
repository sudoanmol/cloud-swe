import { setTimeout as sleep } from 'node:timers/promises';

import { BoatApi, Configuration, ResponseError } from '@boatdev/sdk';
import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation } from '@cloud-swe/protocol/storage';
import { BoatSandboxCreated, BoatWorkspaceInfo } from '@cloud-swe/protocol/workspace';

import type { Env } from '../env';

type BoatEnv = Pick<Env, 'BOAT_API_KEY'>;

const IN_PROGRESS_RETRIES = 10;

function client(env: BoatEnv): BoatApi {
  if (!env.BOAT_API_KEY) throw new Error('Boat not configured');

  // Use the Worker's fetch rather than the SDK's Node HTTP/2 transport.
  return new BoatApi(new Configuration({ accessToken: env.BOAT_API_KEY, fetchApi: fetch }));
}

async function isInProgress(error: Error): Promise<boolean> {
  if (!(error instanceof ResponseError) || error.response.status !== 409) return false;

  return (await error.response.text()).includes('idempotency_in_progress');
}

export async function createBoatSandbox(env: BoatEnv, creation: SessionCreation): Promise<string> {
  const boat = client(env);

  for (let attempt = 1; ; attempt++) {
    try {
      const created = await boat.create(
        {
          // Boat returns the same sandbox for a retried operation instead of a second billable one.
          idempotencyKey: creation.request.operationId,
          createSandboxRequest: {
            environment: creation.request.environment,
            name: `cloud-swe-${creation.workspaceId}`,
            type: 'default',
          },
        },
        { signal: AbortSignal.timeout(30_000) },
      );

      return BoatSandboxCreated.parse(created).sandbox.id;
    } catch (error) {
      if (!(error instanceof Error) || attempt === IN_PROGRESS_RETRIES || !(await isInProgress(error))) throw error;

      await sleep(1000);
    }
  }
}

export async function inspectBoatSandbox(env: BoatEnv, sandboxId: string): Promise<Session['workspace']['state']> {
  const { sandbox } = BoatWorkspaceInfo.parse(
    await client(env).get({ sandboxId }, { signal: AbortSignal.timeout(5000) }),
  );

  if (sandbox.id !== sandboxId || sandbox.access === 'view') throw new Error('Boat workspace not usable');

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
