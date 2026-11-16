/**
 * Path: server/src/sessions/catalog-store.ts
 * Used by: server/src/sessions/{catalog,create,routes,workspace-lifecycle}.ts.
 * Purpose: The Catalog DO's storage keys and their parsing, in one place.
 */

import { SessionCreation, WorkspaceEntry } from '@cloud-swe/protocol/storage';

import { type KvReader as Reader, type KvWriter, listParsed, readParsed } from '../storage.ts';

type Writer = Pick<DurableObjectStorage, 'put'>;

const workspaceKey = (workspaceId: string) => `workspace:${workspaceId}`;

// Marks a creation that may have a sandbox but no workspace entry yet; its value is when it started holding a slot.
const provisioningKey = (workspaceId: string) => `provisioning:${workspaceId}`;

// After a day, a creation that never got a workspace entry no longer holds a slot: any sandbox it made has long since
// paused at its first deadline, and a paused E2B sandbox doesn't run.
const PROVISIONING_MS = 24 * 60 * 60 * 1000;

export async function readCreation(storage: Reader, operationId: string): Promise<SessionCreation | undefined> {
  return readParsed(storage, `operation:${operationId}`, SessionCreation);
}

/** The intent and its provisioning marker commit together, so the concurrency cap sees a sandbox about to exist. */
export async function writeCreation(storage: Writer, creation: SessionCreation) {
  await storage.put({
    [`operation:${creation.request.operationId}`]: creation,
    [provisioningKey(creation.workspaceId)]: Date.parse(creation.createdAt),
  });
}

export async function holdsProvisioning(storage: Reader, workspaceId: string) {
  return (await storage.get(provisioningKey(workspaceId))) !== undefined;
}

export async function holdProvisioning(storage: KvWriter, workspaceId: string) {
  await storage.put(provisioningKey(workspaceId), Date.now());
}

/** For a creation that is known to have made nothing, so it no longer holds a slot. */
export async function releaseProvisioning(storage: Pick<DurableObjectStorage, 'delete'>, workspaceId: string) {
  await storage.delete(provisioningKey(workspaceId));
}

async function provisioningCount(storage: Pick<DurableObjectStorage, 'list'>): Promise<number> {
  const markers = await storage.list<number>({ prefix: provisioningKey('') });

  return [...markers.values()].filter((at) => Date.now() - at < PROVISIONING_MS).length;
}

/** The one sandbox that replaces a deleted workspace, keyed by the workspace it replaces so retries share it. */
export async function readReplacement(storage: Reader, oldWorkspaceId: string): Promise<SessionCreation | undefined> {
  return readParsed(storage, `replacement:${oldWorkspaceId}`, SessionCreation);
}

export async function writeReplacement(storage: Writer, oldWorkspaceId: string, creation: SessionCreation) {
  await storage.put({
    [`replacement:${oldWorkspaceId}`]: creation,
    [provisioningKey(creation.workspaceId)]: Date.parse(creation.createdAt),
  });
}

export async function readWorkspace(storage: Reader, workspaceId: string): Promise<WorkspaceEntry | undefined> {
  return readParsed(storage, workspaceKey(workspaceId), WorkspaceEntry);
}

export async function writeWorkspace(storage: KvWriter, workspace: WorkspaceEntry) {
  await storage.put(workspaceKey(workspace.id), workspace);
}

export async function listWorkspaces(storage: Pick<DurableObjectStorage, 'list'>): Promise<WorkspaceEntry[]> {
  return listParsed(storage, workspaceKey(''), WorkspaceEntry);
}

/** The first entry replaces the provisioning marker in one transaction. */
export async function adoptWorkspace(storage: DurableObjectStorage, workspace: WorkspaceEntry) {
  await storage.transaction(async (tx) => {
    await writeWorkspace(tx, workspace);
    await tx.delete(provisioningKey(workspace.id));
  });
}

/** The creation that made a session; its template is reused for a replacement sandbox. */
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
