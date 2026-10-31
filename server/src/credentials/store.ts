/**
 * Path: server/src/credentials/store.ts
 * Used by: server/src/index.ts; credentials/routes.ts and sessions/thread.ts through the CREDENTIALS binding.
 * Purpose: The Credentials DO: holds the account model key, sign-in sessions and Git identity, and caches GitHub App tokens. Never exposes a key or token through the API.
 */
import {
  GitIdentity,
  ModelCredentialStatus,
  SetModelCredentialRequest,
  StoredModelCredential,
} from '@cloud-swe/protocol/credentials';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

import type { Env } from '../env';
import { mintRepoToken } from '../git/app-token';

/** A cached token is replaced this long before it expires, so whatever receives it can finish with it. */
const TOKEN_MARGIN_MS = 15 * 60 * 1000;

const AuthEntry = z.object({ value: z.string(), expiresAt: z.number().nullable() });

/** Private account credentials; never part of Thread/Pi state or client responses. */
export class Credentials extends DurableObject<Env> {
  // In memory only, so no GitHub token is written to storage; an eviction just mints a new one.
  private readonly repoTokens = new Map<string, { token: string; expiresAt: number }>();

  private async readModel() {
    const raw = await this.ctx.storage.get<unknown>('model:anthropic');

    return raw === undefined ? undefined : StoredModelCredential.parse(raw);
  }

  async modelKey(): Promise<string | undefined> {
    const saved = await this.readModel();

    if (saved) return saved.kind === 'api_key' ? saved.key : undefined;

    return this.env.ANTHROPIC_API_KEY?.trim() || undefined;
  }

  async modelStatus() {
    const saved = await this.readModel();

    const source = saved
      ? saved.kind === 'api_key'
        ? 'client'
        : 'disabled'
      : this.env.ANTHROPIC_API_KEY?.trim()
        ? 'worker'
        : 'none';

    return ModelCredentialStatus.parse({
      provider: 'anthropic',
      source,
      configured: source === 'client' || source === 'worker',
    });
  }

  async setModelKey(raw: SetModelCredentialRequest) {
    const { key } = SetModelCredentialRequest.parse(raw);
    await this.ctx.storage.put('model:anthropic', StoredModelCredential.parse({ kind: 'api_key', key }));

    return this.modelStatus();
  }

  /** For Worker-side GitHub calls only. Undefined when the GitHub App is not installed on the repo. */
  async githubToken(owner: string, repo: string): Promise<string | undefined> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = this.repoTokens.get(key);

    if (cached && cached.expiresAt - Date.now() > TOKEN_MARGIN_MS) return cached.token;
    const minted = await mintRepoToken(this.env, owner, repo);

    if (!minted) {
      this.repoTokens.delete(key);

      return undefined;
    }

    this.repoTokens.set(key, { token: minted.token, expiresAt: Date.parse(minted.expires_at) });

    return minted.token;
  }

  async githubIdentity(): Promise<GitIdentity | undefined> {
    const raw = await this.ctx.storage.get<unknown>('github-identity');

    return raw === undefined ? undefined : GitIdentity.parse(raw);
  }

  async setGitHubIdentity(raw: GitIdentity) {
    await this.ctx.storage.put('github-identity', GitIdentity.parse(raw));
  }

  // Better Auth's session store. ponytail: an entry nobody reads again stays until overwritten; one user keeps this small.
  async authGet(key: string): Promise<string | null> {
    const raw = await this.ctx.storage.get<unknown>('auth:' + key);

    if (raw === undefined) return null;
    const entry = AuthEntry.parse(raw);

    if (entry.expiresAt === null || entry.expiresAt > Date.now()) return entry.value;
    await this.ctx.storage.delete('auth:' + key);

    return null;
  }

  async authSet(key: string, value: string, ttlSeconds?: number) {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    await this.ctx.storage.put('auth:' + key, AuthEntry.parse({ value, expiresAt }));
  }

  async authDelete(key: string) {
    await this.ctx.storage.delete('auth:' + key);
  }

  // A Durable Object's input gate holds other calls across these storage awaits, so both stay atomic.
  async authGetAndDelete(key: string): Promise<string | null> {
    const value = await this.authGet(key);
    await this.authDelete(key);

    return value;
  }

  async authIncrement(key: string, ttlSeconds?: number): Promise<number> {
    const raw = await this.ctx.storage.get<unknown>('auth:' + key);
    const entry = raw === undefined ? undefined : AuthEntry.parse(raw);

    if (entry && (entry.expiresAt === null || entry.expiresAt > Date.now())) {
      const count = Number(entry.value) + 1;
      await this.ctx.storage.put('auth:' + key, { ...entry, value: String(count) });

      return count;
    }

    await this.authSet(key, '1', ttlSeconds);

    return 1;
  }

  async deleteModelKey() {
    // A deletion must not silently reactivate the development Worker-secret fallback.
    await this.ctx.storage.put('model:anthropic', StoredModelCredential.parse({ kind: 'disabled' }));

    return this.modelStatus();
  }
}
