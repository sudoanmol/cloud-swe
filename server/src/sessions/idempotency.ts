/**
 * Path: server/src/sessions/idempotency.ts
 * Used by: server/src/sessions/{cancellation,create,messages,workspace-lifecycle}.ts.
 * Purpose: Repeated calls for one operation: concurrent ones share one promise, and a retry must carry the same request as the first.
 */

/** Concurrent calls for one key share the first call's promise until it settles. */
export function singleFlight<T>() {
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(key: string, task: () => Promise<T>): Promise<T> {
      const running = inFlight.get(key);

      if (running) return running;
      const started = task().finally(() => inFlight.delete(key));
      inFlight.set(key, started);

      return started;
    },
    has: (key: string) => inFlight.has(key),
  };
}

/** Both sides are schema-parsed, so their keys come in the same order. */
export const sameRequest = <T>(stored: T, retried: T) => JSON.stringify(stored) === JSON.stringify(retried);
