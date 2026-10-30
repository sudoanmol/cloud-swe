import type { CodemodeSandbox } from './codemode';
import type { Credentials } from './credentials/store';
import type { SessionCatalog, Thread } from './sessions';

export interface Env {
  CODEMODE: DurableObjectNamespace<CodemodeSandbox>;
  CREDENTIALS: DurableObjectNamespace<Credentials>;
  CATALOG: DurableObjectNamespace<SessionCatalog>;
  THREADS: DurableObjectNamespace<Thread>;
  API_TOKEN: string;
  WORKSPACE_BACKEND: 'docker' | 'boat';
  // Comma-separated Boat environment names that sessions may request.
  WORKSPACE_ENVIRONMENTS: string;
  DOCKER_SANDBOX_URL?: string;
  DOCKER_SANDBOX_TOKEN?: string;
  BOAT_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  MODEL_PROVIDER: string;
  MODEL_ID: string;
}
