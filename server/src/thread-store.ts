/**
 * Path: server/src/thread-store.ts
 * Used by: server/src/git/pull-requests.ts, server/src/prompts/index.ts, server/src/sandbox/{commands,egress,host}.ts, server/src/sessions/{cancellation,keep-alive,messages,projection,summary,thread,workspace-ready}.ts, server/src/tools/{environment,secret-requests}.ts.
 * Purpose: The Thread DO's session, message-intent and cancellation storage keys and their parsing, in one place, with each conversation's current-message and current-cancellation pointers.
 */

import { sessionTitle } from '@cloud-swe/protocol';
import {
  CancelOperation,
  ConversationPointers,
  MessageOperation,
  RewindOperation,
  StoredSession,
} from '@cloud-swe/protocol/storage';
import type { z } from 'zod';

import { type KvReader as Reader, type KvWriter as Writer, reading, readParsed } from './storage.ts';

export async function readSession(storage: Reader): Promise<StoredSession | undefined> {
  return readParsed(storage, 'session', StoredSession);
}

export async function requireSession(storage: Reader): Promise<StoredSession> {
  return reading(StoredSession).parse(await storage.get<unknown>('session'));
}

export async function writeSession(storage: Writer, session: z.input<typeof StoredSession>) {
  await storage.put('session', StoredSession.parse(session));
}

export async function readMessage(storage: Reader, id: string): Promise<MessageOperation | undefined> {
  return readParsed(storage, `message:${id}`, MessageOperation);
}

export async function requireMessage(storage: Reader, id: string): Promise<MessageOperation> {
  return reading(MessageOperation).parse(await storage.get<unknown>(`message:${id}`));
}

export async function hasMessage(storage: Reader, id: string): Promise<boolean> {
  return (await storage.get(`message:${id}`)) !== undefined;
}

async function writeMessage(storage: Writer, operation: MessageOperation) {
  await storage.put(`message:${operation.request.operationId}`, operation);
}

type Pointer = 'currentMessage' | 'currentCancellation';

async function readPointers(storage: Reader, key: Pointer): Promise<ConversationPointers['conversations']> {
  return (await readParsed(storage, key, ConversationPointers))?.conversations ?? {};
}

/** Points `conversationId` at `id`, or clears it, leaving every other conversation's pointer as it is. */
async function writePointer(tx: Reader & Writer, key: Pointer, conversationId: string, id: string | undefined) {
  const { [conversationId]: _replaced, ...others } = await readPointers(tx, key);
  const conversations = id === undefined ? others : { ...others, [conversationId]: id };

  await tx.put(key, ConversationPointers.parse({ conversations }));
}

/** The conversation's newest admitted message. */
export async function currentMessageId(storage: Reader, conversationId: string): Promise<string | undefined> {
  return (await readPointers(storage, 'currentMessage'))[conversationId];
}

/** A notice for the next admitted message, set when the session's sandbox is replaced. */
export async function readNotice(storage: Reader): Promise<string | undefined> {
  return MessageOperation.shape.notice.parse(await storage.get<unknown>('pendingNotice'));
}

/**
 * One atomic write: the intent and its conversation's current-message pointer never disagree. A pending notice moves
 * into the intent.
 */
export async function admitMessage(storage: Pick<DurableObjectStorage, 'transaction'>, operation: MessageOperation) {
  await storage.transaction(async (tx) => {
    await writeMessage(tx, operation);
    await writePointer(tx, 'currentMessage', operation.receipt.conversationId, operation.request.operationId);

    if (operation.notice) await tx.delete('pendingNotice');
  });
}

/** Binds the session to its replacement sandbox and queues the notice, atomically. */
export async function rebindWorkspace(
  storage: Pick<DurableObjectStorage, 'transaction'>,
  workspaceId: StoredSession['workspace']['id'],
  notice: string,
) {
  await storage.transaction(async (tx) => {
    const session = await requireSession(tx);

    // A concurrent message may have bound it already, and its notice may be delivered by now. Bind once.
    if (session.workspace.id === workspaceId) return;
    await writeSession(tx, { ...session, workspace: { ...session.workspace, id: workspaceId } });
    await tx.put('pendingNotice', notice);
  });
}

/** Confirms an admitted intent. The first user message names a session that has no title yet; a rename sticks. */
export async function acceptMessage(storage: Pick<DurableObjectStorage, 'transaction'>, operation: MessageOperation) {
  await storage.transaction(async (tx) => {
    await writeMessage(tx, { ...operation, state: 'accepted' });

    if (operation.system) return;
    const session = await requireSession(tx);

    if (session.title === null) await writeSession(tx, { ...session, title: sessionTitle(operation.request.text) });
  });
}

/** Undo a refused admission atomically, restoring its conversation's previous current-message pointer. */
export async function withdrawMessage(
  storage: Pick<DurableObjectStorage, 'transaction'>,
  operation: MessageOperation,
  previous: string | undefined,
) {
  const id = operation.request.operationId;

  await storage.transaction(async (tx) => {
    await tx.delete(`message:${id}`);
    await writePointer(tx, 'currentMessage', operation.receipt.conversationId, previous === id ? undefined : previous);
  });
}

export async function readCancellation(storage: Reader, id: string): Promise<CancelOperation | undefined> {
  return readParsed(storage, `cancel:${id}`, CancelOperation);
}

export async function hasCancellation(storage: Reader, id: string): Promise<boolean> {
  return (await storage.get(`cancel:${id}`)) !== undefined;
}

export async function writeCancellation(storage: Writer, operation: CancelOperation) {
  await storage.put(`cancel:${operation.request.operationId}`, operation);
}

/** One atomic write: the intent and its conversation's current-cancellation pointer never disagree. */
export async function admitCancellationIntent(
  storage: Pick<DurableObjectStorage, 'transaction'>,
  operation: CancelOperation,
) {
  await storage.transaction(async (tx) => {
    await writeCancellation(tx, operation);
    await writePointer(tx, 'currentCancellation', operation.receipt.conversationId, operation.request.operationId);
  });
}

/** The conversation's latest admitted cancellation; a dangling pointer is corruption and throws. */
export async function currentCancellation(
  storage: Reader,
  conversationId: string,
): Promise<CancelOperation | undefined> {
  const id = (await readPointers(storage, 'currentCancellation'))[conversationId];

  if (id === undefined) return undefined;

  return reading(CancelOperation).parse(await storage.get<unknown>(`cancel:${id}`));
}

export async function readRewind(storage: Reader, id: string): Promise<RewindOperation | undefined> {
  return readParsed(storage, `rewind:${id}`, RewindOperation);
}

export async function hasRewind(storage: Reader, id: string): Promise<boolean> {
  return (await storage.get(`rewind:${id}`)) !== undefined;
}

/** Called inside the transaction that moves the session to the fork, so a receipt exists exactly when the move does. */
export async function writeRewind(tx: Writer, operation: RewindOperation) {
  await tx.put(`rewind:${operation.request.operationId}`, RewindOperation.parse(operation));
}
