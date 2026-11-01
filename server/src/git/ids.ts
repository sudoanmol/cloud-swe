/**
 * Path: server/src/git/ids.ts
 * Used by: server/src/git/{approval-tools,approvals}.ts, server/src/tools/questions.ts.
 * Purpose: Deterministic UUIDs, so a replayed tool call or a repeated decision names the same approval and message operation.
 */

export async function deterministicUuid(name: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)));
  const hex = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0'));
  // Version 5 layout bits, variant 10xx.
  hex[6] = ((Number.parseInt(hex[6] ?? '0', 16) & 0x0f) | 0x50).toString(16).padStart(2, '0');
  hex[8] = ((Number.parseInt(hex[8] ?? '0', 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  const joined = hex.join('');

  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
