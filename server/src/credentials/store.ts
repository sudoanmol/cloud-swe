/**
 * Path: server/src/credentials/store.ts
 * Used by: server/src/index.ts; credentials/routes.ts and sessions/thread.ts through the CREDENTIALS binding.
 * Purpose: The Credentials DO: holds the account model key, returns metadata to clients and never exposes the key through the API.
 */
import {
  type GitIdentity,
  GitHubCredentialStatus,
  ModelCredentialStatus,
  StoredGitHubCredential,
  SetModelCredentialRequest,
  StoredModelCredential,
} from '@cloud-swe/protocol/credentials';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';

/** Private account credentials; never part of Thread/Pi state or client responses. */
export class Credentials extends DurableObject<Env> {
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

  private async readGitHub() {
    const raw = await this.ctx.storage.get<unknown>('github');

    return raw === undefined ? undefined : StoredGitHubCredential.parse(raw);
  }

  /** For Worker-side GitHub calls only. The route layer never returns it. */
  async githubToken(): Promise<string | undefined> {
    return (await this.readGitHub())?.token;
  }

  async githubIdentity(): Promise<GitIdentity | undefined> {
    return (await this.readGitHub())?.identity;
  }

  async githubStatus() {
    const saved = await this.readGitHub();

    return GitHubCredentialStatus.parse(
      saved ? { configured: true, login: saved.identity.login } : { configured: false },
    );
  }

  async setGitHub(token: string, identity: GitIdentity) {
    await this.ctx.storage.put('github', StoredGitHubCredential.parse({ token, identity }));

    return this.githubStatus();
  }

  async deleteGitHub() {
    await this.ctx.storage.delete('github');

    return this.githubStatus();
  }

  async deleteModelKey() {
    // A deletion must not silently reactivate the development Worker-secret fallback.
    await this.ctx.storage.put('model:anthropic', StoredModelCredential.parse({ kind: 'disabled' }));

    return this.modelStatus();
  }
}
