import type { CodemodeSandbox } from './codemode.ts';
import type { Credentials } from './credentials.ts';
import type { SessionCatalog } from './sessions/catalog.ts';
import type { Thread } from './sessions/thread.ts';

// The personal account's single name; per-user names must come from verified server identity.
const ACCOUNT = 'personal';

export interface Env {
  CODEMODE: DurableObjectNamespace<CodemodeSandbox>;
  CREDENTIALS: DurableObjectNamespace<Credentials>;
  CATALOG: DurableObjectNamespace<SessionCatalog>;
  THREADS: DurableObjectNamespace<Thread>;
  // Signs sessions. Only the GitHub account with GITHUB_ALLOWED_USER_ID may sign in.
  BETTER_AUTH_SECRET?: string;
  GITHUB_ALLOWED_USER_ID?: string;
  // The GitHub App: OAuth sign-in (client ID and secret) and installation tokens (client ID and PKCS#8 private key).
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  WORKSPACE_BACKEND: 'docker' | 'boat';
  // Comma-separated Boat environment names that sessions may request.
  WORKSPACE_ENVIRONMENTS: string;
  // Optional numbers, read through workspaces/settings.ts.
  MAX_SANDBOXES?: string;
  SANDBOX_DELETE_AFTER_DAYS?: string;
  KEEPALIVE_INTERVAL_SECONDS?: string;
  DOCKER_SANDBOX_URL?: string;
  DOCKER_SANDBOX_TOKEN?: string;
  BOAT_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  // Enables the web_search and web_fetch tools; used in the Worker only.
  FIRECRAWL_API_KEY?: string;
  // The Worker's public https base URL (no trailing slash). Sign-in callbacks and the sandboxes' Git proxy use it.
  PUBLIC_URL?: string;
  MODEL_PROVIDER: string;
  MODEL_ID: string;
}

export const catalogStub = (env: Pick<Env, 'CATALOG'>) => env.CATALOG.get(env.CATALOG.idFromName(ACCOUNT));

export const credentialsStub = (env: Pick<Env, 'CREDENTIALS'>) =>
  env.CREDENTIALS.get(env.CREDENTIALS.idFromName(ACCOUNT));

export const threadStub = (env: Pick<Env, 'THREADS'>, sessionId: string) =>
  env.THREADS.get(env.THREADS.idFromName(sessionId));
