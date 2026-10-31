import type { z } from 'zod';

// Durable Object storage and its transactions satisfy these, so callers keep their atomicity and tests can use a Map.
export type KvReader = { get<T>(key: string): Promise<T | undefined> };

export type KvWriter = { put<T>(key: string, value: T): Promise<void> };

/** The stored value parsed with `schema`, or undefined when the key is absent. */
export async function readParsed<S extends z.ZodType>(
  storage: KvReader,
  key: string,
  schema: S,
): Promise<z.output<S> | undefined> {
  const raw = await storage.get<unknown>(key);

  return raw === undefined ? undefined : schema.parse(raw);
}
