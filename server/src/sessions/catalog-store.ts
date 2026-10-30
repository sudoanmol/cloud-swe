/**
 * Path: server/src/sessions/catalog-store.ts
 * Used by: server/src/sessions/{catalog,create,message-routes,read-routes}.ts.
 * Purpose: The SessionCatalog DO's storage keys and their parsing, in one place.
 */
import { SessionCreation, WorkspaceEntry } from '@cloud-swe/protocol/storage';

type Reader = Pick<DurableObjectStorage, 'get'>;

type Writer = Pick<DurableObjectStorage, 'put'>;

export async function readCreation(storage: Reader, operationId: string): Promise<SessionCreation | undefined> {
  const raw = await storage.get<unknown>(`operation:${operationId}`);

  return raw === undefined ? undefined : SessionCreation.parse(raw);
}

// Boat's idempotency window: after it, a creation that never got a workspace entry no longer holds a slot.
const PROVISIONING_MS = 24 * 60 * 60 * 1000;

/** The intent and its provisioning marker commit together, so the concurrency cap sees a sandbox about to exist. */
export async function writeCreation(storage: Writer, creation: SessionCreation) {
  await storage.put({
    [`operation:${creation.request.operationId}`]: creation,
    [`provisioning:${creation.workspaceId}`]: Date.parse(creation.createdAt),
  });
}

/** For a creation that is known to have made nothing, so it no longer holds a slot. */
export async function releaseProvisioning(storage: Pick<DurableObjectStorage, 'delete'>, workspaceId: string) {
  await storage.delete(`provisioning:${workspaceId}`);
}

/** Creations that may have a sandbox but no workspace entry yet. */
async function provisioningCount(storage: Pick<DurableObjectStorage, 'list'>): Promise<number> {
  const markers = await storage.list<number>({ prefix: 'provisioning:' });

  return [...markers.values()].filter((at) => Date.now() - at < PROVISIONING_MS).length;
}

/** The one sandbox that replaces a deleted workspace, keyed by the workspace it replaces so retries share it. */
export async function readReplacement(storage: Reader, oldWorkspaceId: string): Promise<SessionCreation | undefined> {
  const raw = await storage.get<unknown>(`replacement:${oldWorkspaceId}`);

  return raw === undefined ? undefined : SessionCreation.parse(raw);
}

export async function writeReplacement(storage: Writer, oldWorkspaceId: string, creation: SessionCreation) {
  await storage.put({
    [`replacement:${oldWorkspaceId}`]: creation,
    [`provisioning:${creation.workspaceId}`]: Date.parse(creation.createdAt),
  });
}

export async function readWorkspace(storage: Reader, workspaceId: string): Promise<WorkspaceEntry | undefined> {
  const raw = await storage.get<unknown>(`workspace:${workspaceId}`);

  return raw === undefined ? undefined : WorkspaceEntry.parse(raw);
}

export async function listWorkspaces(storage: Pick<DurableObjectStorage, 'list'>): Promise<WorkspaceEntry[]> {
  const rows = await storage.list<unknown>({ prefix: 'workspace:' });

  return [...rows.values()].map((raw) => WorkspaceEntry.parse(raw));
}

/** The first entry replaces the provisioning marker in one transaction. */
export async function adoptWorkspace(storage: DurableObjectStorage, workspace: WorkspaceEntry) {
  await storage.transaction(async (tx) => {
    await tx.put(`workspace:${workspace.id}`, workspace);
    await tx.delete(`provisioning:${workspace.id}`);
  });
}

/** The creation that made a session; its environment is reused for a replacement sandbox. */
export async function readSessionCreation(storage: Reader, sessionId: string): Promise<SessionCreation | undefined> {
  const raw = await storage.get<unknown>(`id:${sessionId}`);

  return raw === undefined ? undefined : SessionCreation.parse(raw);
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

/** Sandboxes that run or are being created. Stored state only, so it costs no Boat call. */
export async function runningCount(storage: Pick<DurableObjectStorage, 'list'>, except?: string): Promise<number> {
  const entries = await listWorkspaces(storage);

  return (
    entries.filter((entry) => entry.state === 'running' && entry.id !== except).length +
    (await provisioningCount(storage))
  );
}
