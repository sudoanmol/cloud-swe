/**
 * Path: server/src/sessions/catalog-store.ts
 * Used by: server/src/sessions/{catalog,create,message-routes,read-routes}.ts.
 * Purpose: The SessionCatalog DO's storage keys and their parsing, in one place.
 */
import { SessionCreation, WorkspaceRecord } from '@cloud-swe/protocol/storage';

type Reader = Pick<DurableObjectStorage, 'get'>;

type Writer = Pick<DurableObjectStorage, 'put'>;

export async function readCreation(storage: Reader, operationId: string): Promise<SessionCreation | undefined> {
  const raw = await storage.get<unknown>(`operation:${operationId}`);

  return raw === undefined ? undefined : SessionCreation.parse(raw);
}

export async function writeCreation(storage: Writer, creation: SessionCreation) {
  await storage.put(`operation:${creation.request.operationId}`, creation);
}

export async function readWorkspace(storage: Reader, workspaceId: string): Promise<WorkspaceRecord | undefined> {
  const raw = await storage.get<unknown>(`workspace:${workspaceId}`);

  return raw === undefined ? undefined : WorkspaceRecord.parse(raw);
}

export async function writeWorkspace(storage: Writer, workspace: WorkspaceRecord) {
  await storage.put(`workspace:${workspace.id}`, workspace);
}

export async function hasSession(storage: Reader, sessionId: string): Promise<boolean> {
  return (await storage.get(`id:${sessionId}`)) !== undefined;
}

/** One atomic write: the lookup row and the creation-ordered list row appear together. */
export async function indexSession(storage: Writer, creation: SessionCreation, createdAt: string) {
  await storage.put({
    [`id:${creation.sessionId}`]: creation,
    [`session:${createdAt}:${creation.sessionId}`]: creation,
  });
}

/** `startAfter` is a list key from a previous page; each entry's key is the next cursor position. */
export async function listSessions(
  storage: Pick<DurableObjectStorage, 'list'>,
  startAfter: string | undefined,
  limit: number,
) {
  const rows = await storage.list<unknown>({ prefix: 'session:', startAfter, limit: limit + 1 });

  const page = [...rows.entries()].slice(0, limit).map(([key, raw]) => ({ key, creation: SessionCreation.parse(raw) }));

  return { page, hasMore: rows.size > limit };
}
