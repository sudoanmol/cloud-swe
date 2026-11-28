/**
 * Path: server/src/credentials.ts
 * Used by: server/src/{env,index}.ts.
 * Purpose: The Credentials DO and its /v1/credentials routes: holds the account model key, sign-in sessions, Git identity and environments, and caches GitHub App tokens. Never exposes a key or token through the API.
 */

import {
  GitIdentity,
  ModelCredentialParams,
  ModelCredentialStatus,
  SetModelCredentialRequest,
  StoredModelCredential,
} from '@cloud-swe/protocol/credentials';
import type { SetNetworkSecretRequest, UpdatedBy } from '@cloud-swe/protocol/environments';
import { StoredSignInCode } from '@cloud-swe/protocol/storage';
import { DurableObject } from 'cloudflare:workers';
import type { Hono } from 'hono';
import { z } from 'zod';

import { credentialsStub, type Env } from './env.ts';
import * as environments from './environments.ts';
import { apiError } from './errors.ts';
import { appInstallations, mintInstallationToken } from './github.ts';
import { readParsed, reading } from './storage.ts';

export function credentialRoutes(app: Hono<{ Bindings: Env }>) {
  app.on(['GET', 'PUT', 'DELETE'], '/v1/credentials/models/:provider', async (c) => {
    if (!ModelCredentialParams.safeParse(c.req.param()).success) return apiError('unsupported_provider');
    c.header('Cache-Control', 'no-store');
    const store = credentialsStub(c.env);

    if (c.req.method === 'GET') return c.json(await store.modelStatus());

    if (c.req.method === 'DELETE') return c.json(await store.deleteModelKey());
    const parsed = SetModelCredentialRequest.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) return apiError('invalid_request');

    return c.json(await store.setModelKey(parsed.data));
  });
}

/** A cached token is replaced this long before it expires, so whatever receives it can finish with it. */
const TOKEN_MARGIN_MS = 15 * 60 * 1000;

/** A failed token lookup is remembered this long, so callers fail fast while GitHub is failing instead of asking again. */
const FAILURE_MEMORY_MS = 30_000;

/** The list of accounts the App is installed on is read again after this long, so a new installation shows up. */
const INSTALLATIONS_MEMORY_MS = 30_000;

const AuthEntry = z.object({ value: z.string(), expiresAt: z.number().nullable() });

const MODEL_KEY = 'model:anthropic';

const authKey = (key: string) => 'auth:' + key;

const SIGN_IN_CODE_PREFIX = 'sign-in-code:';

/** Private account credentials; never part of Thread/Pi state or client responses. */
export class Credentials extends DurableObject<Env> {
  // In memory only, so no GitHub token is written to storage; an eviction just mints a new one.
  private readonly installationTokens = new Map<number, { token: string; expiresAt: number }>();
  private installations?: { byLogin: Map<string, number>; readAt: number };
  // When the last failed lookup stops being remembered. "Not installed" is an answer, not a failure.
  private githubFailedUntil = 0;

  private async model(): Promise<{ source: 'client' | 'worker' | 'disabled' | 'none'; key?: string }> {
    const saved = await readParsed(this.ctx.storage, MODEL_KEY, StoredModelCredential);

    if (saved) return saved.kind === 'api_key' ? { source: 'client', key: saved.key } : { source: 'disabled' };
    const key = this.env.ANTHROPIC_API_KEY?.trim();

    return key ? { source: 'worker', key } : { source: 'none' };
  }

  async modelKey(): Promise<string | undefined> {
    return (await this.model()).key;
  }

  async modelStatus() {
    const { source } = await this.model();

    return ModelCredentialStatus.parse({
      provider: 'anthropic',
      source,
      configured: source === 'client' || source === 'worker',
    });
  }

  async setModelKey({ key }: SetModelCredentialRequest) {
    await this.ctx.storage.put(MODEL_KEY, StoredModelCredential.parse({ kind: 'api_key', key }));

    return this.modelStatus();
  }

  /** The token of the installation `pick` chooses among the accounts the App is installed on, or undefined. */
  private async installationToken(pick: (byLogin: Map<string, number>) => number | undefined) {
    if (this.githubFailedUntil > Date.now()) throw new Error('GitHub token lookup failed recently');

    try {
      if (!this.installations || Date.now() - this.installations.readAt > INSTALLATIONS_MEMORY_MS) {
        this.installations = { byLogin: await appInstallations(this.env), readAt: Date.now() };
      }

      const installation = pick(this.installations.byLogin);

      if (installation === undefined) return undefined;
      const cached = this.installationTokens.get(installation);

      if (cached && cached.expiresAt - Date.now() > TOKEN_MARGIN_MS) return cached.token;
      const minted = await mintInstallationToken(this.env, installation);
      this.installationTokens.set(installation, { token: minted.token, expiresAt: Date.parse(minted.expires_at) });

      return minted.token;
    } catch (error) {
      this.githubFailedUntil = Date.now() + FAILURE_MEMORY_MS;
      throw error;
    }
  }

  /**
   * For the Git proxy. A token for every repository the App was given on `owner`'s account, or undefined when it is
   * not installed there, so other owners' public repositories go anonymously.
   */
  githubToken(owner: string): Promise<string | undefined> {
    return this.installationToken((byLogin) => byLogin.get(owner.toLowerCase()));
  }

  /**
   * For a GitHub API call from a sandbox, which must carry some token: the installation of the first of `owners` that
   * has one, else the signed-in account's, else any. Undefined only when the App is installed nowhere.
   */
  async githubApiToken(owners: string[]): Promise<string | undefined> {
    const login = (await this.githubIdentity())?.login;

    return this.installationToken((byLogin) => {
      const known = [...owners, ...(login ? [login] : [])].find((owner) => byLogin.has(owner.toLowerCase()));

      return known ? byLogin.get(known.toLowerCase()) : byLogin.values().next().value;
    });
  }

  async githubIdentity(): Promise<GitIdentity | undefined> {
    return readParsed(this.ctx.storage, 'github-identity', GitIdentity);
  }

  async setGitHubIdentity(identity: GitIdentity) {
    await this.ctx.storage.put('github-identity', GitIdentity.parse(identity));
  }

  // Better Auth's session store. ponytail: an entry nobody reads again stays until overwritten; one user keeps this small.
  /** The unexpired entry, or undefined; an expired one is deleted. */
  private async authEntry(key: string) {
    const entry = await readParsed(this.ctx.storage, authKey(key), AuthEntry);

    if (!entry || entry.expiresAt === null || entry.expiresAt > Date.now()) return entry;
    await this.ctx.storage.delete(authKey(key));

    return undefined;
  }

  async authGet(key: string): Promise<string | null> {
    return (await this.authEntry(key))?.value ?? null;
  }

  async authSet(key: string, value: string, ttlSeconds?: number) {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    await this.ctx.storage.put(authKey(key), AuthEntry.parse({ value, expiresAt }));
  }

  async authDelete(key: string) {
    await this.ctx.storage.delete(authKey(key));
  }

  // A Durable Object's input gate holds other calls across these storage awaits, so both stay atomic.
  async authGetAndDelete(key: string): Promise<string | null> {
    const value = await this.authGet(key);
    await this.authDelete(key);

    return value;
  }

  async authIncrement(key: string, ttlSeconds?: number): Promise<number> {
    const entry = await this.authEntry(key);

    if (entry) {
      const count = Number(entry.value) + 1;
      await this.ctx.storage.put(authKey(key), { ...entry, value: String(count) });

      return count;
    }

    await this.authSet(key, '1', ttlSeconds);

    return 1;
  }

  // The app's sign-in codes. The alarm rings at the earliest expiry and deletes every expired code, so one nobody
  // exchanges doesn't stay.
  async storeSignInCode(code: string, row: z.input<typeof StoredSignInCode>) {
    await this.ctx.storage.put(SIGN_IN_CODE_PREFIX + code, StoredSignInCode.parse(row));
    const alarm = await this.ctx.storage.getAlarm();

    if (alarm === null || alarm > row.expiresAt) await this.ctx.storage.setAlarm(row.expiresAt);
  }

  /** The code's row, deleted in the same step: the input gate holds a second exchange until this one is done. */
  async takeSignInCode(code: string): Promise<StoredSignInCode | undefined> {
    const row = await readParsed(this.ctx.storage, SIGN_IN_CODE_PREFIX + code, StoredSignInCode);
    await this.ctx.storage.delete(SIGN_IN_CODE_PREFIX + code);

    return row;
  }

  override async alarm() {
    const now = Date.now();
    const codes = await this.ctx.storage.list({ prefix: SIGN_IN_CODE_PREFIX });
    const pending: number[] = [];

    for (const [key, raw] of codes) {
      const { expiresAt } = reading(StoredSignInCode).parse(raw);

      if (expiresAt > now) pending.push(expiresAt);
      else await this.ctx.storage.delete(key);
    }

    if (pending.length > 0) await this.ctx.storage.setAlarm(Math.min(...pending));
  }

  // Environments, in ./environments.ts. Only sandboxView and networkSwaps leave this DO with values, for the sandbox
  // sync and the network proxy; the views clients get never carry a network value or placeholder.
  listEnvironments() {
    return environments.listEnvironments(this.ctx.storage);
  }

  hasEnvironment(name: string) {
    return environments.hasEnvironment(this.ctx.storage, name);
  }

  putEnvironment(name: string) {
    return environments.putEnvironment(this.ctx.storage, name);
  }

  deleteEnvironment(name: string) {
    return environments.deleteEnvironment(this.ctx.storage, name);
  }

  setVariable(environment: string, name: string, value: string | null, by: UpdatedBy, receiptId?: string) {
    return environments.setVariable(this.ctx.storage, environment, name, value, by, receiptId);
  }

  setNetworkSecret(environment: string, name: string, secret: z.output<typeof SetNetworkSecretRequest>) {
    const ownHost = this.env.PUBLIC_URL ? new URL(this.env.PUBLIC_URL).hostname : undefined;

    return environments.setNetworkSecret(this.ctx.storage, ownHost, environment, name, secret);
  }

  deleteNetworkSecret(environment: string, name: string) {
    return environments.deleteNetworkSecret(this.ctx.storage, environment, name);
  }

  sandboxView(environment: string) {
    return environments.sandboxView(this.ctx.storage, environment);
  }

  networkSwaps(environment: string, host: string) {
    return environments.networkSwaps(this.ctx.storage, environment, host);
  }

  promptView(environment: string) {
    return environments.promptView(this.ctx.storage, environment);
  }

  async deleteModelKey() {
    // A deletion must not silently reactivate the development Worker-secret fallback.
    await this.ctx.storage.put(MODEL_KEY, StoredModelCredential.parse({ kind: 'disabled' }));

    return this.modelStatus();
  }
}
