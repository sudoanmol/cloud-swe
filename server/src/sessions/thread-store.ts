/**
 * Path: server/src/sessions/thread-store.ts
 * Used by: server/src/sessions/{thread,messages,message-state,cancellation}.ts, server/src/tools/{host,commands}.ts.
 * Purpose: The Thread DO's session, message-intent and cancellation storage keys and their parsing, in one place.
 */
import { OperationId, Session } from '@cloud-swe/protocol';
import { CancelOperation, MessageOperation } from '@cloud-swe/protocol/storage';

// Both DurableObjectStorage and a transaction satisfy these, so callers keep their atomicity.

type Reader = Pick<DurableObjectStorage, 'get'>;

type Writer = Pick<DurableObjectStorage, 'put'>;

export async function readSession(storage: Reader): Promise<Session | undefined> {
  const raw = await storage.get<unknown>('session');

  return raw === undefined ? undefined : Session.parse(raw);
}

export async function requireSession(storage: Reader): Promise<Session> {
  return Session.parse(await storage.get<unknown>('session'));
}

export async function writeSession(storage: Writer, session: Session) {
  await storage.put('session', session);
}

export async function readMessage(storage: Reader, id: string): Promise<MessageOperation | undefined> {
  const raw = await storage.get<unknown>(`message:${id}`);

  return raw === undefined ? undefined : MessageOperation.parse(raw);
}

export async function requireMessage(storage: Reader, id: string): Promise<MessageOperation> {
  return MessageOperation.parse(await storage.get<unknown>(`message:${id}`));
}

export async function hasMessage(storage: Reader, id: string): Promise<boolean> {
  return (await storage.get(`message:${id}`)) !== undefined;
}

export async function writeMessage(storage: Writer, operation: MessageOperation) {
  await storage.put(`message:${operation.request.operationId}`, operation);
}

export async function currentMessageId(storage: Reader): Promise<string | undefined> {
  const raw = await storage.get<unknown>('currentMessage');

  return raw === undefined ? undefined : OperationId.parse(raw);
}

/** One atomic write: the intent and the current-message pointer never disagree. */
export async function admitMessage(storage: Writer, operation: MessageOperation) {
  await storage.put({
    [`message:${operation.request.operationId}`]: operation,
    currentMessage: operation.request.operationId,
  });
}

/** Undo a refused admission atomically, restoring the previous current-message pointer. */
export async function withdrawMessage(
  storage: Pick<DurableObjectStorage, 'transaction'>,
  id: string,
  previous: string | undefined,
) {
  await storage.transaction(async (tx) => {
    await tx.delete(`message:${id}`);

    if (previous === undefined || previous === id) await tx.delete('currentMessage');
    else await tx.put('currentMessage', previous);
  });
}

export async function readCancellation(storage: Reader, id: string): Promise<CancelOperation | undefined> {
  const raw = await storage.get<unknown>(`cancel:${id}`);

  return raw === undefined ? undefined : CancelOperation.parse(raw);
}

export async function hasCancellation(storage: Reader, id: string): Promise<boolean> {
  return (await storage.get(`cancel:${id}`)) !== undefined;
}

export async function writeCancellation(storage: Writer, operation: CancelOperation) {
  await storage.put(`cancel:${operation.request.operationId}`, operation);
}

/** One atomic write: the intent and the current-cancellation pointer never disagree. */
export async function admitCancellationIntent(storage: Writer, operation: CancelOperation) {
  await storage.put({
    [`cancel:${operation.request.operationId}`]: operation,
    currentCancellation: operation.request.operationId,
  });
}

/** The latest admitted cancellation; a dangling pointer is corruption and throws. */
export async function currentCancellation(storage: Reader): Promise<CancelOperation | undefined> {
  const id = await storage.get<unknown>('currentCancellation');

  if (id === undefined) return undefined;

  return CancelOperation.parse(await storage.get<unknown>(`cancel:${OperationId.parse(id)}`));
}
