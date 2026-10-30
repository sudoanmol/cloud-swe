/**
 * Path: server/src/git/capability.ts
 * Used by: server/src/git/{access,proxy-auth}.ts.
 * Purpose: The per-session Git capability token: random, stored only as a SHA-256 hash with a 1 h expiry, and the sandbox git config that carries it.
 */
import { GitAccess } from '@cloud-swe/protocol/storage';

import type { KvReader as Reader, KvWriter as Writer } from './kv.ts';

const TTL_MS = 60 * 60 * 1000;

const REFRESH_MARGIN_MS = 20 * 60 * 1000;

const KEY = 'gitAccess';

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export const newToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

async function readAccess(storage: Reader) {
  const raw = await storage.get<unknown>(KEY);

  return raw === undefined ? undefined : GitAccess.parse(raw);
}

/** Rotates the session's capability. The previous token lasts until its own expiry, for Git commands already running. */
export async function storeToken(storage: Reader & Writer, token: string): Promise<void> {
  const current = await readAccess(storage);

  const previous =
    current && current.expiresAt > Date.now() ? { hash: current.hash, expiresAt: current.expiresAt } : undefined;

  await storage.put(KEY, GitAccess.parse({ hash: await sha256(token), expiresAt: Date.now() + TTL_MS, previous }));
}

/** Whether the current token is missing or close enough to expiry that a long Git command could outlive it. */
export async function tokenExpiring(storage: Reader): Promise<boolean> {
  const current = await readAccess(storage);

  return !current || current.expiresAt - Date.now() < REFRESH_MARGIN_MS;
}

/** Whether `token` is one of this session's unexpired capabilities. */
export async function tokenValid(storage: Reader, token: string): Promise<boolean> {
  const access = await readAccess(storage);

  if (!access) return false;
  const hash = await sha256(token);

  return [access, access.previous].some((known) => known && known.expiresAt > Date.now() && known.hash === hash);
}

/** The sandbox-side config: rewrite github.com to this session's proxy and send the capability token to it. */
export function gitConfig(publicUrl: string, sessionId: string, token: string): string {
  const proxy = `${publicUrl}/git/${sessionId}/`;

  return [
    `[url "${proxy}github.com/"]`,
    '\tinsteadOf = https://github.com/',
    `[http "${proxy}"]`,
    `\textraHeader = Authorization: Bearer ${token}`,
    '',
  ].join('\n');
}
