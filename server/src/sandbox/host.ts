/**
 * Path: server/src/sandbox/host.ts
 * Used by: server/src/git/{access,approval-tools,clone,github-tool,pull-requests,tools}.ts, server/src/prompts/index.ts, server/src/sandbox/{command-lifecycle,command-records,commands,egress,environment}.ts, server/src/sessions/{keep-alive,projection,summary,thread,workspace-ready}.ts, server/src/tools/{environment,questions,registry,web-output}.ts.
 * Purpose: What tools reach the session through: its storage, its sandbox binding, and the Pi live doc's tool slots.
 */

import { WorkspaceRecord } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { LiveDoc, type ToolExecutionApi } from '@earendil-works/pi-durable';
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

/** The tool tasks still running in any of the session's conversations: a command one of them owns is not an orphan. */
export async function liveTaskIds(host: ToolHost): Promise<number[]> {
  const pi = await host.harness.pi();
  const storage = await host.harness.storage();
  let page = await storage.scanConversations({}, 100, undefined, BG);
  const conversations = [...page.items];

  while (page.next !== undefined) {
    page = await storage.scanConversations({}, 100, page.next, BG);
    conversations.push(...page.items);
  }

  return pi.commit(async (tx) => {
    const slots = [];

    for (const { id } of conversations) {
      const live = await tx.doc(LiveDoc, id);
      slots.push(...(live.tools ?? []), ...(live.nestedTools ?? []));
    }

    return slots
      .filter((slot) => slot.status !== 'done')
      .flatMap((slot) => (slot.taskId === undefined ? [] : [Number(slot.taskId)]));
  }, BG);
}

/** The Pi input whose run made this tool call, and the call that nested it, if any. */
export function runBinding(api: ToolExecutionApi) {
  return api.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, api.conversationId);
    const first = live.run?.inputs[0];

    if (!first) throw new Error('Missing native run binding');

    return {
      id: first,
      parentToolCallId: live.nestedTools?.find((slot) => slot.taskId === api.taskId)?.parentCallId ?? null,
    };
  }, BG);
}
