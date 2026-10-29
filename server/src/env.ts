import type { SessionCatalog, Thread } from './sessions';

export interface Env {
  CATALOG: DurableObjectNamespace<SessionCatalog>;
  THREADS: DurableObjectNamespace<Thread>;
  API_TOKEN: string;
  WORKSPACE_ID: string;
  WORKSPACE_BACKEND: 'docker' | 'boat';
  DOCKER_SANDBOX_URL?: string;
  DOCKER_SANDBOX_TOKEN?: string;
  BOAT_API_KEY?: string;
  BOAT_SANDBOX_ID?: string;
  MODEL_PROVIDER: string;
  MODEL_ID: string;
}
