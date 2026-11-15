/**
 * Path: server/src/storage.ts
 * Used by: server/src/{credentials,environments,follow-ups,thread-store}.ts, server/src/git/{access,approvals,clone,pull-store,repos}.ts, server/src/sandbox/{command-records,egress}.ts, server/src/sessions/catalog-store.ts, server/src/tools/{questions,secret-requests}.ts.
 * Purpose: The key-value shapes Durable Object storage and its transactions both satisfy, and parsed reads over them.
 */

import type { z } from 'zod';

// Callers keep their atomicity by passing a transaction, and tests can use a Map.
export type KvReader = { get<T>(key: string): Promise<T | undefined> };

export type KvWriter = { put<T>(key: string, value: T): Promise<void> };

export type KvLister = { list<T>(options: { prefix: string }): Promise<Map<string, T>> };

/** The stored value parsed with `schema`, or undefined when the key is absent. */
export async function readParsed<S extends z.ZodType>(
  storage: KvReader,
  key: string,
  schema: S,
): Promise<z.output<S> | undefined> {
  const raw = await storage.get<unknown>(key);

  return raw === undefined ? undefined : schema.parse(raw);
}

/** Every value under `prefix`, parsed with `schema`, in key order. */
export async function listParsed<S extends z.ZodType>(
  storage: KvLister,
  prefix: string,
  schema: S,
): Promise<z.output<S>[]> {
  const rows = await storage.list<unknown>({ prefix });

  return [...rows.values()].map((raw) => schema.parse(raw));
}
