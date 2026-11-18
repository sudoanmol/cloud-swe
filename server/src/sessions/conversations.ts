/**
 * Path: server/src/sessions/conversations.ts
 * Used by: server/src/sessions/thread.ts.
 * Purpose: Going back in a conversation: forks the active conversation just above an entry and moves the session to the fork, once per operation ID.
 */

import { RewindReceipt, type RewindRequest, type Session } from '@cloud-swe/protocol';
import { RewindOperation } from '@cloud-swe/protocol/storage';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import type { Conversation, EntryId } from '@earendil-works/pi-durable';

import { failure, type Result, success } from '../errors.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { hasCancellation, hasMessage, readRewind, requireSession, writeRewind, writeSession } from '../thread-store.ts';
import { dropCutRequests } from './cut-requests.ts';
import { writeNotice } from './notice.ts';
import { requireConversation } from './pi.ts';

// Tools that can change files or Git in the sandbox; codemode's scripts call the others.
const FILE_TOOLS = new Set(['bash', 'write', 'edit', 'codemode', 'git_clone']);

const FILES_KEPT_NOTICE =
  'The user went back to this point in the conversation. Files and Git in the sandbox were not reverted and may ' +
  'contain changes made after it. Check the current state before relying on memory.';

const IDLE_RUNS: ReadonlySet<Session['run']['kind']> = new Set(['idle', 'completed', 'cancelled', 'failed']);

/** Pi's ID of the entry the client named, when the conversation shows one by it. */
async function visibleEntry(conversation: Conversation, before: string): Promise<EntryId | undefined> {
  const native = Number(before);

  // Only Pi's own spelling of a number names an entry, as with conversation IDs.
  if (!Number.isSafeInteger(native) || native < 1 || String(native) !== before) return undefined;

  // SAFETY: a positive safe integer is the shape of every Pi entry ID, and the scan answers whether this one is visible.
  const id = native as EntryId;
  const page = await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BG);

  return page.items[0]?.id;
}

/** Whether the entries from `from` on hold a result of a tool that can change files. */
async function cutChangedFiles(conversation: Conversation, from: EntryId): Promise<boolean> {
  const query = { minEntryId: from, order: 'ascending' } as const;
  let page = await conversation.entries(query, 100, undefined, BG);

  for (;;) {
    const ran = page.items.some((entry) =>
      (entry.model ?? []).some((message) => message.role === 'toolResult' && FILE_TOOLS.has(message.toolName)),
    );

    if (ran) return true;

    if (page.next === undefined) return false;
    page = await conversation.entries(query, 100, page.next, BG);
  }
}

/** A conversation holding the entries above `cut`: a fork at the one just above it, or an empty one. */
async function forkAbove(host: ToolHost, conversation: Conversation, cut: EntryId): Promise<Conversation> {
  // SAFETY: only an upper bound for the scan; it need not name an entry.
  const below = (cut - 1) as EntryId;
  const above = await conversation.entries({ maxEntryId: below, order: 'descending' }, 1, undefined, BG);
  const at = above.items[0]?.id;

  if (at !== undefined) return conversation.fork(at, { ownership: { kind: 'ownerless' } }, BG);

  // Nothing above the cut to fork at. A fork carries the whole agent configuration; a new conversation gets the model,
  // the one thing a session configures (see SessionThread.initialize). Copy more here if a session ever sets more.
  const { model } = await conversation.agent(BG);

  if (!model) throw new Error('Missing Pi binding');

  return (await host.harness.pi()).createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: { provider: model.provider, modelId: model.modelId } } },
    BG,
  );
}

/** Called under the Thread's admission gate, with the session as it is now. */
export async function rewind(
  host: ToolHost,
  session: Session,
  conversationId: string,
  request: RewindRequest,
): Promise<Result<RewindReceipt>> {
  const { storage } = host;
  const { operationId, before } = request;

  if ((await hasMessage(storage, operationId)) || (await hasCancellation(storage, operationId)))
    return failure('operation_conflict');

  // Before every check below: a retry gets its receipt though the conversation it named is no longer active.
  const saved = await readRewind(storage, operationId);

  if (saved) {
    const same = saved.request.conversationId === conversationId && saved.request.before === before;

    return same ? success(RewindReceipt.parse(saved.receipt)) : failure('operation_conflict');
  }

  if (conversationId !== session.activeConversationId) return failure('conversation_not_active');

  const idle = IDLE_RUNS.has(session.run.kind) && session.pending.length === 0 && session.compaction === null;

  if (!idle) return failure('session_not_idle');
  const conversation = await requireConversation(host.harness, conversationId);
  const cut = await visibleEntry(conversation, before);

  if (cut === undefined) return failure('entry_not_found');

  // A crash from here to the transaction leaves a fork nothing points at, and a retry makes another. Nothing lists
  // conversations, so it is unreachable. If something ever does, write the operation ID inside the fork's commit and
  // look it up before forking.
  const fork = await forkAbove(host, conversation, cut);
  const forkId = String(fork.id);

  if (await cutChangedFiles(conversation, cut))
    await writeNotice(host.harness, forkId, `rewind:${operationId}`, FILES_KEPT_NOTICE);

  const operation = RewindOperation.parse({
    request: { operationId, conversationId, before },
    receipt: {
      operationId,
      sessionId: session.id,
      conversationId: forkId,
      action: 'rewind_conversation',
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    },
  });

  await storage.transaction(async (tx) => {
    const stored = await requireSession(tx);

    await writeRewind(tx, operation);
    await writeSession(tx, { ...stored, runtime: { conversationId: forkId, rewoundAt: operation.receipt.acceptedAt } });
    await dropCutRequests(tx, Number(before));
  });

  return success(RewindReceipt.parse(operation.receipt));
}
