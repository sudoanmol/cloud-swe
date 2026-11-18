/**
 * Path: server/test/fakes.ts
 * Used by: server/test/{approvals.test,catalog-store.test,cut-requests.test,egress-sync.test,environment-delivery.test,git-policy.test,network-proxy.test,secret-answer-race.test,stored-records.test}.ts.
 * Purpose: In-memory stand-ins for Durable Object storage and a stored session, for tests that run without a Worker.
 */

import { StoredSession } from '@cloud-swe/protocol/storage';

/**
 * Key-value storage over a Map. Values are copied in and out, as Durable Object storage serializes them, so a caller
 * reads back exactly what was written, in the key order it was written.
 */
export function memoryStorage(rows = new Map<string, unknown>()) {
  const storage = {
    rows,
    async get<T>(key: string): Promise<T | undefined> {
      // SAFETY: tests read each key as the type the code under test stored there.
      return structuredClone(rows.get(key)) as T | undefined;
    },
    /** One key and value, or several as an object, like Durable Object storage. */
    async put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
      const entries = key instanceof Object ? Object.entries(key) : [[key, value] as const];

      for (const [name, entry] of entries) rows.set(name, structuredClone(entry));
    },
    async delete(key: string): Promise<boolean> {
      return rows.delete(key);
    },
    async list<T>({
      prefix = '',
      startAfter = '',
      end,
      reverse = false,
      limit = Infinity,
    }: { prefix?: string; startAfter?: string; end?: string; reverse?: boolean; limit?: number } = {}) {
      const keys = [...rows.keys()]
        .filter((key) => key.startsWith(prefix) && key > startAfter && (end === undefined || key < end))
        .toSorted();

      const listed = reverse ? keys.toReversed() : keys;

      // SAFETY: as for get.
      return new Map(listed.slice(0, limit).map((key) => [key, structuredClone(rows.get(key)) as T]));
    },
  };

  // Tests make no concurrent writes, so a transaction runs on the same rows with nothing to isolate.
  return { ...storage, transaction: <T>(change: (tx: typeof storage) => Promise<T>) => change(storage) };
}

/** A stored session in the environment `dev`. */
export function fakeSession(workspaceId = crypto.randomUUID()) {
  const now = new Date().toISOString();

  return StoredSession.parse({
    id: crypto.randomUUID(),
    runtime: { conversationId: '1' },
    model: { provider: 'anthropic', id: 'm' },
    workspace: { id: workspaceId },
    environment: 'dev',
    title: null,
    createdAt: now,
  });
}
