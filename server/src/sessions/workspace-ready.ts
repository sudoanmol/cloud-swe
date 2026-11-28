/**
 * Path: server/src/sessions/workspace-ready.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Makes a session's sandbox usable before a message is admitted: resumes a stopped one, or replaces a deleted one with a new empty sandbox and queues a notice for the model.
 */

import type { StoredSession } from '@cloud-swe/protocol/storage';

import { catalogStub } from '../env.ts';
import { type ApiFailure, failure } from '../errors.ts';
import { branchSuffix, readRepos } from '../git/repos.ts';
import { endCommandsOfDeletedSandbox } from '../sandbox/command-lifecycle.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { rebindWorkspace, requireSession } from '../thread-store.ts';
import { sandboxLimitParams } from '../workspaces/settings.ts';
import { sandboxReplacedNotice } from './notice.ts';

async function replaceWorkspace(host: ToolHost, session: StoredSession) {
  const replaced = await catalogStub(host.env).replaceWorkspace(session.id, session.workspace.id);

  if (!replaced.ok) return replaced;

  const repos = (await readRepos(host.storage)).map(
    (repo) => `${repo.url} at ${repo.path}, session branches cloud-swe/*-${branchSuffix(session.id)}`,
  );

  await rebindWorkspace(host.storage, replaced.workspaceId, sandboxReplacedNotice(repos));
  // The new sandbox has none of the old one's processes.
  await endCommandsOfDeletedSandbox(host);

  return replaced;
}

/** Undefined once the sandbox is usable, else the error to answer the message with. */
export async function readyWorkspace(host: ToolHost): Promise<ApiFailure | undefined> {
  const session = await requireSession(host.storage);
  const resumed = await catalogStub(host.env).resumeWorkspace(session.id, session.workspace.id);
  const result = resumed.ok || resumed.reason !== 'expired' ? resumed : await replaceWorkspace(host, session);

  if (result.ok) return undefined;

  return result.reason === 'limit'
    ? failure('sandbox_limit_reached', sandboxLimitParams(host.env))
    : failure('sandbox_not_ready');
}
