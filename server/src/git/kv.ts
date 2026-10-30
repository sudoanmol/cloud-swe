/**
 * Path: server/src/git/kv.ts
 * Used by: server/src/git/{repos,capability,proxy-auth}.ts.
 * Purpose: The two storage operations the Git modules need, so tests can use a Map and Durable Object storage still satisfies them.
 */
export type KvReader = { get<T>(key: string): Promise<T | undefined> };

export type KvWriter = { put<T>(key: string, value: T): Promise<void> };
