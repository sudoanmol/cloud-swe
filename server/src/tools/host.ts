import { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import type { PiHarness } from 'agents/harness/pi';

import type { Env } from '../env.ts';
import { requireSession } from '../sessions/thread-store.ts';
import type { CommandReconciler } from './command-reconciler.ts';

export type ToolHost = {
  env: Env;
  storage: DurableObjectStorage;
  harness: PiHarness;
  reconciler: CommandReconciler;
};

export async function toolWorkspace(host: ToolHost): Promise<WorkspaceRecord> {
  const session = await requireSession(host.storage);

  // workspaceBinding rejects a mismatched session or workspace.
  return WorkspaceRecord.parse(
    await host.env.CATALOG.get(host.env.CATALOG.idFromName('personal')).workspaceBinding(
      session.id,
      session.workspace.id,
    ),
  );
}
