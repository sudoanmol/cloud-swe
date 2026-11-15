import { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { PiHarness } from 'agents/harness/pi';

import { catalogStub, type Env } from '../env.ts';
import type { PollingJob } from '../polling-job.ts';
import { requireSession } from '../thread-store.ts';

export type ToolHost = {
  env: Env;
  storage: DurableObjectStorage;
  harness: PiHarness;
  reconciler: PollingJob;
};

export async function toolWorkspace(host: ToolHost): Promise<WorkspaceRecord> {
  const session = await requireSession(host.storage);

  // workspaceBinding rejects a mismatched session or workspace.
  return WorkspaceRecord.parse(await catalogStub(host.env).workspaceBinding(session.id, session.workspace.id));
}
