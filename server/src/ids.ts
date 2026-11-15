/**
 * Path: server/src/ids.ts
 * Used by: server/src/{environments,follow-ups}.ts, server/src/git/{access,approval-tools,approvals}.ts, server/src/sandbox/egress.ts, server/src/tools/{environment,questions,secret-requests}.ts.
 * Purpose: Hashes, random capability tokens and deterministic UUIDs, so a replayed tool call or a repeated decision names the same record and message operation.
 */

export const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/** 256 random bits as hex: a capability a sandbox holds for one session. */
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

export async function deterministicUuid(name: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name))).subarray(0, 16);
  // Version 5 layout bits, variant 10xx.
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const joined = hex(digest);

  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
