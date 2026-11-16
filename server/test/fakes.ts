/**
 * Path: server/test/fakes.ts
 * Used by: server/test/{approvals.test,catalog-store.test,egress-sync.test,environment-delivery.test,git-policy.test,network-proxy.test,secret-answer-race.test}.ts.
 * Purpose: In-memory stand-ins for Durable Object storage and a stored session, for tests that run without a Worker.
 */

import { Session } from '@cloud-swe/protocol';

/**
 * Key-value storage over a Map. Values are copied in and out, as Durable Object storage serializes them, so a caller
 * reads back exactly what was written, in the key order it was written.
 */
export function memoryStorage(rows = new Map<string, unknown>()) {
  return {
    rows,
    async get<T>(key: string): Promise<T | undefined> {
      // SAFETY: tests read each key as the type the code under test stored there.
      return structuredClone(rows.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      rows.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<boolean> {
      return rows.delete(key);
    },
    async list<T>({
      prefix = '',
      startAfter = '',
      limit = Infinity,
    }: { prefix?: string; startAfter?: string; limit?: number } = {}) {
      const keys = [...rows.keys()].filter((key) => key.startsWith(prefix) && key > startAfter).toSorted();

      // SAFETY: as for get.
      return new Map(keys.slice(0, limit).map((key) => [key, structuredClone(rows.get(key)) as T]));
    },
  };
}

/** A stored session in the environment `dev`, on a running Docker workspace. */
export function fakeSession(workspaceId = crypto.randomUUID()) {
  const now = new Date().toISOString();

  return Session.parse({
    id: crypto.randomUUID(),
    runtime: { conversationId: '1' },
    model: { provider: 'anthropic', id: 'm' },
    workspace: { id: workspaceId, provider: 'docker', state: 'running' },
    environment: 'dev',
    capabilities: { submitMessage: true, cancelRun: true, tools: [], approvals: true, delegation: false },
    run: { kind: 'idle' },
    createdAt: now,
    updatedAt: now,
  });
}
