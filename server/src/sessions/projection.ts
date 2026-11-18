/**
 * Path: server/src/sessions/projection.ts
 * Used by: server/src/sessions/{summary,thread}.ts.
 * Purpose: The public Session a Thread shows: its stored record, with run, pending, compaction and todos read from its active conversation, and the remote commands a conversation's runs own.
 */

import type { Session } from '@cloud-swe/protocol';
import { pullRequestView, repoView, sessionView } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';

import { approvalProjection } from '../git/approvals.ts';
import { listPulls } from '../git/pull-store.ts';
import { readRepos } from '../git/repos.ts';
import { commandRunState } from '../sandbox/command-lifecycle.ts';
import { commandOperations } from '../sandbox/command-records.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { readMessage, requireSession } from '../thread-store.ts';
import { questionProjection } from '../tools/questions.ts';
import { secretRequestProjection } from '../tools/secret-requests.ts';
import { readTodos } from '../tools/todo.ts';
import { compactionState } from './compaction.ts';
import { messageState } from './messages.ts';
import { sessionUsage } from './models.ts';
import { requireConversation } from './pi.ts';

/** Local storage and Pi reads only, so it is safe inside the admission gate. */
export async function sessionProjection(host: ToolHost, workspace: Session['workspace']['state']): Promise<Session> {
  const saved = await requireSession(host.storage);
  const active = saved.runtime.conversationId;
  const conversation = await requireConversation(host.harness, active);
  const agent = await conversation.agent(BG);

  if (!agent.model) throw new Error('Missing Pi binding');

  // The transcript already stamps every message, so activity needs no write of its own.
  const recent = await conversation.entries({ order: 'descending' }, 8, undefined, BG);
  const stamps = recent.items.flatMap((entry) => (entry.model ?? []).map(({ timestamp }) => timestamp));
  // Going back counts as activity too, though it leaves an older message as the newest.
  const rewoundAt = Date.parse(saved.runtime.rewoundAt ?? saved.createdAt);
  const updatedAt = new Date(Math.max(Date.parse(saved.createdAt), rewoundAt, ...stamps)).toISOString();

  const native = await messageState(host, active);
  // A command the sandbox can't account for blocks every conversation, since they share the sandbox.
  const remote = await commandRunState(host);
  const compaction = await compactionState(host.harness, active);

  return sessionView(saved, {
    workspaceState: workspace,
    repos: (await readRepos(host.storage)).map(repoView),
    approvals: await approvalProjection(host.storage),
    pullRequests: (await listPulls(host.storage)).map(pullRequestView),
    questions: await questionProjection(host.storage),
    secretRequests: await secretRequestProjection(host.storage),
    todos: await readTodos(await host.harness.pi(), conversation.id),
    usage: await sessionUsage(host.harness),
    updatedAt,
    model: { provider: agent.model.provider, id: agent.model.modelId },
    ...native,
    ...compaction,
    run: remote ?? native.run,
  });
}

/** The open remote commands that runs of this conversation started. */
export async function conversationCommands(host: ToolHost, conversationId: string) {
  const commands = await commandOperations(host);
  const owners = await Promise.all(commands.map((op) => readMessage(host.storage, op.messageOperationId)));

  return commands.filter((_, index) => owners[index]?.receipt.conversationId === conversationId);
}
