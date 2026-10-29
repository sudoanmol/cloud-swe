import { BoatApi, Configuration } from '@boatdev/sdk';
import { BoatWorkspaceInfo, DockerWorkspaceInfo } from '@cloud-swe/protocol/workspace';
import type { Session } from '@cloud-swe/protocol';
import type { Env } from './env';

export async function inspectWorkspace(env: Pick<Env,
  'WORKSPACE_BACKEND' | 'DOCKER_SANDBOX_URL' | 'DOCKER_SANDBOX_TOKEN' | 'BOAT_API_KEY' | 'BOAT_SANDBOX_ID'
>): Promise<Session['workspace']['state']> {
  if (env.WORKSPACE_BACKEND === 'docker') {
    if (!env.DOCKER_SANDBOX_URL || !env.DOCKER_SANDBOX_TOKEN) throw new Error('Docker not configured');
    const response = await fetch(new URL('/workspace', env.DOCKER_SANDBOX_URL), {
      headers: { Authorization: `Bearer ${env.DOCKER_SANDBOX_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Docker unavailable');
    DockerWorkspaceInfo.parse(await response.json());
    return 'running';
  }
  if (env.WORKSPACE_BACKEND !== 'boat' || !env.BOAT_API_KEY || !env.BOAT_SANDBOX_ID) {
    throw new Error('Workspace backend not configured');
  }
  // Use the Worker's fetch rather than the SDK's Node HTTP/2 transport.
  const boat = new BoatApi(new Configuration({ accessToken: env.BOAT_API_KEY, fetchApi: fetch }));
  const { sandbox } = BoatWorkspaceInfo.parse(await boat.get(
    { sandboxId: env.BOAT_SANDBOX_ID }, { signal: AbortSignal.timeout(5000) },
  ));
  if (sandbox.id !== env.BOAT_SANDBOX_ID || sandbox.access === 'view') throw new Error('Boat workspace not usable');
  if (sandbox.health === 'degraded') return 'unreachable';
  switch (sandbox.state) {
    case 'ready': case 'idle': case 'running': return 'running';
    case 'init': case 'provisioning': case 'provisioned': case 'cloning': return 'starting';
    case 'archiving': case 'archived': return 'stopped';
    case 'error': case 'cancelled': return 'error';
    default: { const exhaustive: never = sandbox.state; return exhaustive; }
  }
}
