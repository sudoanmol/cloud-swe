import type { EnvValues } from "@cloud-swe/db/env-sets";

/**
 * Exact-match replacement of secret values with `[REDACTED:NAME]`. Encoded,
 * split, or transformed values are not caught; that limit is documented.
 */
export type Redactor = {
  redact(text: string): string;
  /** Per-stream redaction for live chunks. Holds back text that may begin a secret. */
  stream(): (chunk: string) => string;
};

export const noRedaction: Redactor = { redact: (text) => text, stream: () => (chunk) => chunk };

export function createRedactor(secrets: Record<string, string>): Redactor {
  // Longest first, so a value that contains another is replaced whole.
  const entries = Object.entries(secrets)
    .filter(([, value]) => value.length > 0)
    .sort(([, left], [, right]) => right.length - left.length);

  if (entries.length === 0) return noRedaction;
  const holdback = Math.max(...entries.map(([, value]) => value.length)) - 1;

  function redact(text: string): string {
    let result = text;

    for (const [name, value] of entries) result = result.split(value).join(`[REDACTED:${name}]`);

    return result;
  }

  /** Move `cut` before any occurrence that would straddle it. */
  function safeCut(text: string, initial: number): number {
    let cut = initial;
    let moved = true;

    while (moved) {
      moved = false;

      for (const [, value] of entries) {
        for (
          let index = text.indexOf(value, Math.max(0, cut - value.length + 1));
          index !== -1 && index < cut;
          index = text.indexOf(value, index + 1)
        ) {
          if (index + value.length > cut) {
            cut = index;
            moved = true;
          }
        }
      }
    }

    return cut;
  }

  return {
    redact,
    stream() {
      let pending = "";

      // A secret split across chunks is complete only once its tail arrives,
      // so the last `holdback` characters wait for the next chunk. The final
      // tool result replaces the live preview, so held text is never flushed.
      return (chunk) => {
        pending += chunk;
        const cut = safeCut(pending, Math.max(0, pending.length - holdback));
        const ready = pending.slice(0, cut);
        pending = pending.slice(cut);

        return redact(ready);
      };
    },
  };
}

/** Redact a run's secret entries; plain entries stay visible. */
export function secretRedactor(env: EnvValues | null): Redactor {
  return createRedactor(
    Object.fromEntries(
      (env?.entries ?? [])
        .filter((entry) => entry.secret)
        .map((entry) => [entry.name, env?.values[entry.name] ?? ""]),
    ),
  );
}
