/**
 * Path: server/src/storage.ts
 * Used by: server/src/{credentials,environments,follow-ups,thread-store}.ts, server/src/git/{access,approvals,clone,pull-store,repos}.ts, server/src/sandbox/{command-records,egress}.ts, server/src/sessions/{attachments,catalog-store,cut-requests}.ts, server/src/tools/{questions,secret-requests}.ts.
 * Purpose: The key-value shapes Durable Object storage and its transactions both satisfy, and parsed reads over them. The one place a stored row written by an older version is upgraded.
 */

import { StoredRow, upgradesOf } from '@cloud-swe/protocol/storage';
import { z } from 'zod';

// Callers keep their atomicity by passing a transaction, and tests can use a Map.
export type KvReader = { get<T>(key: string): Promise<T | undefined> };

export type KvWriter = { put<T>(key: string, value: T): Promise<void> };

export type KvLister = { list<T>(options: { prefix: string }): Promise<Map<string, T>> };

export type KvDeleter = { delete(key: string): Promise<boolean> };

/** Brings a row of an older version up to the current one, a step at a time. A newer row keeps its version and fails. */
function upgraded(row: StoredRow, upgrades: readonly ((row: StoredRow) => StoredRow)[]): StoredRow {
  if (row.version >= upgrades.length) return row;

  return { ...upgrades.slice(row.version).reduce((next, upgrade) => upgrade(next), row), version: upgrades.length };
}

/**
 * How a stored value is read with `schema`: a record kind's row is upgraded first, so the caller gets, and later writes
 * back, the current shape. Any other schema reads the value as it is.
 */
export function reading<S extends z.ZodType>(schema: S) {
  const upgrades = upgradesOf(schema);

  if (upgrades.length === 0) return schema;

  return z.preprocess((raw) => {
    const row = StoredRow.safeParse(raw);

    return row.success ? upgraded(row.data, upgrades) : raw;
  }, schema);
}

/** The stored value parsed with `schema`, or undefined when the key is absent. */
export async function readParsed<S extends z.ZodType>(
  storage: KvReader,
  key: string,
  schema: S,
): Promise<z.output<S> | undefined> {
  const raw = await storage.get<unknown>(key);

  return raw === undefined ? undefined : reading(schema).parse(raw);
}

/** Every value under `prefix`, parsed with `schema`, in key order. */
export async function listParsed<S extends z.ZodType>(
  storage: KvLister,
  prefix: string,
  schema: S,
): Promise<z.output<S>[]> {
  const rows = await storage.list<unknown>({ prefix });

  return [...rows.values()].map((raw) => reading(schema).parse(raw));
}
