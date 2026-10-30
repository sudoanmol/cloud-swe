import {
  ModelCredentialStatus,
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

  async deleteModelKey() {
    // A deletion must not silently reactivate the development Worker-secret fallback.
    await this.ctx.storage.put('model:anthropic', StoredModelCredential.parse({ kind: 'disabled' }));

    return this.modelStatus();
  }
}
