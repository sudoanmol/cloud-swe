/**
 * Path: server/src/sessions/catalog-store.ts
 * Used by: server/src/sessions/{catalog,create,routes,workspace-lifecycle}.ts.
 * Purpose: The Catalog DO's storage keys and their parsing, in one place.
 */

import { SessionCreation, WorkspaceEntry } from '@cloud-swe/protocol/storage';

import { readParsed } from '../storage.ts';

type Reader = Pick<DurableObjectStorage, 'get'>;

type Writer = Pick<DurableObjectStorage, 'put'>;

export async function readCreation(storage: Reader, operationId: string): Promise<SessionCreation | undefined> {
  return readParsed(storage, `operation:${operationId}`, SessionCreation);
}

// After a day, a creation that never got a workspace entry no longer holds a slot: any sandbox it made has long since
// paused at its first deadline, and a paused E2B sandbox doesn't run.
const PROVISIONING_MS = 24 * 60 * 60 * 1000;

/** The intent and its provisioning marker commit together, so the concurrency cap sees a sandbox about to exist. */
export async function writeCreation(storage: Writer, creation: SessionCreation) {
  await storage.put({
    [`operation:${creation.request.operationId}`]: creation,
    [`provisioning:${creation.workspaceId}`]: Date.parse(creation.createdAt),
  });
}

export async function holdsProvisioning(storage: Pick<DurableObjectStorage, 'get'>, workspaceId: string) {
  return (await storage.get(`provisioning:${workspaceId}`)) !== undefined;
}

export async function holdProvisioning(storage: Pick<DurableObjectStorage, 'put'>, creation: SessionCreation) {
  await storage.put(`provisioning:${creation.workspaceId}`, Date.now());
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
  return readParsed(storage, `replacement:${oldWorkspaceId}`, SessionCreation);
}

export async function writeReplacement(storage: Writer, oldWorkspaceId: string, creation: SessionCreation) {
  await storage.put({
    [`replacement:${oldWorkspaceId}`]: creation,
    [`provisioning:${creation.workspaceId}`]: Date.parse(creation.createdAt),
  });
}

export async function readWorkspace(storage: Reader, workspaceId: string): Promise<WorkspaceEntry | undefined> {
  return readParsed(storage, `workspace:${workspaceId}`, WorkspaceEntry);
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
  return readParsed(storage, `id:${sessionId}`, SessionCreation);
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
  storage: { list(options: DurableObjectListOptions): Promise<Map<string, unknown>> },
  startAfter: string | undefined,
  limit: number,
) {
  const rows = await storage.list({ prefix: 'session:', startAfter, limit: limit + 1 });

  // The ID is the key's last part; only the keys are read, so a row from an older schema can't fail the whole list.
  const page = [...rows.keys()].slice(0, limit).map((key) => ({ key, sessionId: key.slice(key.lastIndexOf(':') + 1) }));

  return { page, hasMore: rows.size > limit };
}

/** Sandboxes that run or are being created. Stored state only, so it costs no provider call. */
export async function runningCount(storage: Pick<DurableObjectStorage, 'list'>, except?: string): Promise<number> {
  const entries = await listWorkspaces(storage);

  return (
    entries.filter((entry) => entry.state === 'running' && entry.id !== except).length +
    (await provisioningCount(storage))
  );
}
