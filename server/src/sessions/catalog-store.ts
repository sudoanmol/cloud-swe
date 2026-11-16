/**
 * Path: server/src/sessions/catalog-store.ts
 * Used by: server/src/sessions/{catalog,create,workspace-lifecycle}.ts.
 * Purpose: The Catalog DO's storage keys and their parsing, in one place.
 */

import {
  SessionCreation,
  SessionListPosition,
  StoredSessionSummary,
  summaryView,
  WorkspaceEntry,
} from '@cloud-swe/protocol/storage';

import { type KvReader as Reader, type KvWriter, listParsed, readParsed, reading } from '../storage.ts';
import { FIRST_CONVERSATION } from './pi.ts';

type Writer = Pick<DurableObjectStorage, 'put'>;

const workspaceKey = (workspaceId: string) => `workspace:${workspaceId}`;

// Marks a creation that may have a sandbox but no workspace entry yet; its value is when it started holding a slot.
const provisioningKey = (workspaceId: string) => `provisioning:${workspaceId}`;

// After a day, a creation that never got a workspace entry no longer holds a slot: any sandbox it made has long since
// paused at its first deadline, and a paused E2B sandbox doesn't run.
const PROVISIONING_MS = 24 * 60 * 60 * 1000;

/**
 * This Catalog's own random ID, made on first use. Every sandbox it creates is stamped with it, and the orphan sweep
 * only ever considers sandboxes that carry it, so production, local dev and test runs never touch each other's.
 */
export async function catalogId(storage: Pick<DurableObjectStorage, 'transaction'>): Promise<string> {
  return storage.transaction(async (tx) => {
    const stored = await tx.get<string>('catalog-id');

    if (stored) return stored;
    const id = crypto.randomUUID();
    await tx.put('catalog-id', id);

    return id;
  });
}

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

const summaryKey = (sessionId: string) => `summary:${sessionId}`;

// The list's order key: newest `updatedAt` first when listed in reverse, then by ID.
const activityKey = (row: StoredSessionSummary) => `activity:${row.updatedAt}:${row.sessionId}`;

/**
 * Moves a session's list row to its new order key in one transaction. `summary:<id>` holds the row's current key, so
 * the old one is found without the session saying what it last wrote.
 */
async function putSummary(tx: DurableObjectTransaction, row: StoredSessionSummary) {
  const before = await tx.get<string>(summaryKey(row.sessionId));
  const key = activityKey(row);

  if (before !== undefined && before !== key) await tx.delete(before);
  await tx.put({ [key]: row, [summaryKey(row.sessionId)]: key });
}

export async function writeSummary(storage: DurableObjectStorage, row: StoredSessionSummary) {
  await storage.transaction((tx) => putSummary(tx, row));
}

/**
 * The lookup row, and the session's first list row unless the session already wrote a newer one. One transaction, so a
 * session that exists is listed.
 */
export async function indexSession(
  storage: DurableObjectStorage,
  creation: SessionCreation,
  row: StoredSessionSummary,
) {
  await storage.transaction(async (tx) => {
    await tx.put(`id:${creation.sessionId}`, creation);

    if ((await tx.get(summaryKey(row.sessionId))) === undefined) await putSummary(tx, row);
  });
}

/**
 * Sessions created before list rows existed have a `session:<createdAt>:<id>` index row and no summary. Each gets the
 * row the Catalog can derive (idle, untitled, last active at creation) and loses the old index row; the session writes
 * its real row the next time it starts. Runs when the Catalog starts, and finds nothing once done.
 */
export async function fillSummaries(storage: DurableObjectStorage) {
  for (const key of (await storage.list({ prefix: 'session:' })).keys()) {
    const createdAt = key.slice('session:'.length, key.lastIndexOf(':'));

    const row = StoredSessionSummary.safeParse({
      sessionId: key.slice(key.lastIndexOf(':') + 1),
      activeConversationId: FIRST_CONVERSATION,
      title: null,
      preview: null,
      run: { kind: 'idle' },
      openRequests: 0,
      createdAt,
      updatedAt: createdAt,
    });

    // A key that isn't in the old format is left as it is rather than guessed at.
    if (!SessionListPosition.safeParse(key).success || !row.success) continue;

    await storage.transaction(async (tx) => {
      if ((await tx.get(summaryKey(row.data.sessionId))) === undefined) await putSummary(tx, row.data);
      await tx.delete(key);
    });
  }
}

/**
 * A page of list rows, newest activity first. `before` is the order key a previous page ended on. A row that no longer
 * parses is left out, and the cursor is still the key of the last row read.
 */
export async function listSummaries(
  storage: Pick<DurableObjectStorage, 'list'>,
  before: string | undefined,
  limit: number,
) {
  const rows = await storage.list({ prefix: 'activity:', end: before, reverse: true, limit: limit + 1 });
  const page = [...rows].slice(0, limit);

  return {
    sessions: page.flatMap(([, raw]) => {
      const row = reading(StoredSessionSummary).safeParse(raw);

      return row.success ? [summaryView(row.data)] : [];
    }),
    next: rows.size > limit ? page.at(-1)?.[0] : undefined,
  };
}

/** Sandboxes that run or are being created. Stored state only, so it costs no provider call. */
export async function runningCount(storage: Pick<DurableObjectStorage, 'list'>, except?: string): Promise<number> {
  const entries = await listWorkspaces(storage);

  return (
    entries.filter((entry) => entry.state === 'running' && entry.id !== except).length +
    (await provisioningCount(storage))
  );
}
