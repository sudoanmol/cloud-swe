import { createEnvSetStore } from "@cloud-swe/db/env-sets";
import { createModelCredentialStore } from "@cloud-swe/db/model-credentials";
import {
  createAuth,
  githubCredentialsFromEnv,
  requireGithubAppOAuthInProduction,
} from "@cloud-swe/auth";
import { createDb } from "@cloud-swe/db";
import { createOnboardingStore } from "@cloud-swe/db/onboarding";
import { createThreadStore } from "@cloud-swe/db/threads";
import { createModalReviewRunner } from "@cloud-swe/api/workspace-sandbox";
import { publicFailure } from "@cloud-swe/db/public-failure";
import { env as databaseEnv } from "@cloud-swe/env/database";
import { env as authEnv } from "@cloud-swe/env/auth";
import { env } from "@cloud-swe/env/server";
import { Pool } from "pg";
import { env as gitEnv } from "@cloud-swe/env/git";
import { env as previewEnv } from "@cloud-swe/env/preview";
import { browserConfig } from "@cloud-swe/env/browser";
import { createAgentBrowsers } from "@cloud-swe/db/agent-browsers";
import { createGitStore, gitError } from "@cloud-swe/db/git-store";
import { createGithubClient } from "@cloud-swe/api/github";
import { createGitBundles } from "@cloud-swe/api/git-bundles";
import { createAttachmentObjectStore } from "@cloud-swe/db/attachment-objects";
import { attachmentStorageConfig } from "@cloud-swe/env/attachments";
import { cleanupExpiredAttachments } from "@cloud-swe/api/routers/attachments";

import { buildServer } from "./app";
import type { FastifyRequest } from "fastify";
import { createTitleGenerator, type TitleGenerator } from "./title-generation";

const pool = new Pool({
  connectionString: databaseEnv.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});

// Checked-out clients emit errors between queries; pg still rejects their next query.
pool.on("connect", (client) => client.on("error", () => undefined));

pool.on("error", () => {
  process.stderr.write(
    JSON.stringify({
      level: "error",
      message: "PostgreSQL idle connection failed; pool will reconnect",
    }) + "\n",
  );
});

const database = createDb(pool);

const github = githubCredentialsFromEnv({
  GITHUB_CLIENT_ID: authEnv.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: authEnv.GITHUB_CLIENT_SECRET,
});

requireGithubAppOAuthInProduction({ nodeEnv: env.NODE_ENV, github });

const auth = createAuth({
  database,
  secret: authEnv.BETTER_AUTH_SECRET,
  baseURL: authEnv.BETTER_AUTH_URL,
  trustedOrigins: [env.CORS_ORIGIN],
  github,
});

const authProvider = {
  getSession: async (headers: Headers) => {
    // API authorization must observe database truth, including revocation and
    // onboarding eligibility. The signed cookie cache is a UI optimization.
    const session = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    });

    if (!session) return null;

    return {
      user: {
        id: session.user.id,
        emailVerified: session.user.emailVerified,
      },
      session: session.session,
    };
  },
  handler: (request: Request) => auth.handler(request),
};

const store = createThreadStore(database);

const browser = browserConfig();

const onboardingStore = createOnboardingStore(database);

let titleGenerator: TitleGenerator | undefined;

/**
 * Refresh the signed Better Auth session cookie cache through its HTTP handler
 * so the browser receives new `Set-Cookie` headers with the updated
 * `onboardingCompleted` field. Authorization never trusts the cached copy.
 */
async function refreshSessionCookies(request: FastifyRequest): Promise<string[]> {
  const url = new URL("/api/auth/get-session", authEnv.BETTER_AUTH_URL);

  url.searchParams.set("disableCookieCache", "true");
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) headers.set(name, value);
  }

  const response = await auth.handler(new Request(url.toString(), { method: "GET", headers }));

  await response.arrayBuffer();

  return response.headers.getSetCookie();
}

const attachmentConfig = attachmentStorageConfig();

const attachmentObjects = attachmentConfig
  ? createAttachmentObjectStore(attachmentConfig)
  : undefined;

const modelEncryptionKey = env.MODEL_CREDENTIALS_ENCRYPTION_KEY;

if (env.RUNNER_EXECUTION_MODE === "pi" && !modelEncryptionKey)
  throw new Error("MODEL_CREDENTIALS_ENCRYPTION_KEY is required for Pi execution");

const envSets = env.ENVIRONMENT_ENCRYPTION_KEY
  ? createEnvSetStore(database, env.ENVIRONMENT_ENCRYPTION_KEY)
  : undefined;

if (env.RUNNER_EXECUTION_MODE === "pi" && !envSets)
  throw new Error("ENVIRONMENT_ENCRYPTION_KEY is required for Pi execution");

const gitConfigured = Boolean(
  gitEnv.GIT_BROKER_URL && gitEnv.GIT_BROKER_SECRET && gitEnv.GIT_BROKER_STORAGE,
);

if (
  [gitEnv.GIT_BROKER_URL, gitEnv.GIT_BROKER_SECRET, gitEnv.GIT_BROKER_STORAGE].some(Boolean) &&
  !gitConfigured
)
  throw new Error("Set GIT_BROKER_URL, GIT_BROKER_SECRET, and GIT_BROKER_STORAGE together");

const githubClient = createGithubClient(async (userId) => {
  const result = await pool.query<{ id: string }>(
    "select id from account where user_id=$1 and provider_id=$2 limit 1",
    [userId, "github"],
  );

  const accountId = result.rows[0]?.id;

  if (!accountId) return gitError("GIT_ACCESS_DENIED", 403);

  try {
    const result = await auth.api.getAccessToken({ body: { accountId, userId } });

    if (!result.accessToken) return gitError("GIT_ACCESS_DENIED", 403);

    return result.accessToken;
  } catch {
    return gitError("GIT_ACCESS_DENIED", 403);
  }
});

const gitStore = createGitStore(database);

const gitBundles = createGitBundles(
  gitEnv.GIT_BROKER_STORAGE ?? ".git-broker",
  gitEnv.GIT_BROKER_MAX_BYTES,
  gitEnv.GIT_BROKER_MIN_FREE_BYTES,
);

const server = buildServer({
  attachmentObjects,
  attachmentStore: store,
  git: gitConfigured
    ? {
        store: gitStore,
        github: githubClient,
        bundles: gitBundles,
        secret: gitEnv.GIT_BROKER_SECRET!,
        publicUrl: gitEnv.GIT_BROKER_URL!.replace(/\/$/, ""),
        maxBytes: gitEnv.GIT_BROKER_MAX_BYTES,
        envFor: envSets?.readRunValues,
      }
    : undefined,
  githubRead: { github: githubClient, store: gitStore, appSlug: authEnv.GITHUB_APP_SLUG },
  onboarding: {
    store: onboardingStore,
    appSlug: authEnv.GITHUB_APP_SLUG,
    github: github ? githubClient : undefined,
    refreshSession: refreshSessionCookies,
  },
  scheduleTitle: (input) => titleGenerator?.schedule(input),
  browser: {
    store,
    browsers: browser
      ? createAgentBrowsers({ apiKey: browser.kernelApiKey, idleSeconds: browser.idleSeconds })
      : undefined,
  },
  workspace: {
    store,
    previewDomain: previewEnv.PREVIEW_DOMAIN,
    run:
      env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET
        ? createModalReviewRunner({
            tokenId: env.MODAL_TOKEN_ID,
            tokenSecret: env.MODAL_TOKEN_SECRET,
            environment: env.MODAL_ENVIRONMENT,
          })
        : undefined,
  },
  auth: authProvider,
  store,
  environments: envSets ? { store: envSets } : undefined,
  modelCredentials: modelEncryptionKey
    ? (userId) => createModelCredentialStore(database, userId, modelEncryptionKey)
    : undefined,
  requireModelSelection: env.RUNNER_EXECUTION_MODE === "pi",
  trustedOrigins: [env.CORS_ORIGIN],
  runLimit: env.MAX_ACTIVE_RUNS,
  pollMs: env.SSE_POLL_MS,
  heartbeatMs: env.SSE_HEARTBEAT_MS,
  nodeEnv: env.NODE_ENV,
  allowUnverifiedCompute: env.NODE_ENV !== "production" && env.ALLOW_UNVERIFIED_COMPUTE !== "false",
  computeAccess: async (userId) => {
    const result = await pool.query<{ account_id: string }>(
      'select account_id from "account" where "user_id" = $1 and "provider_id" = $2',
      [userId, "github"],
    );

    return result.rows.some((account) => env.ALLOWED_GITHUB_ACCOUNT_IDS.has(account.account_id));
  },
});

titleGenerator = createTitleGenerator({
  store,
  apiKey: env.DEEPSEEK_API_KEY,
  apiUrl: env.DEEPSEEK_API_URL,
  logger: server.log,
});

if (attachmentObjects) {
  const cleanup = () =>
    cleanupExpiredAttachments(store, attachmentObjects).catch(() => {
      server.log.error("Attachment cleanup failed");
    });

  const attachmentCleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
  attachmentCleanupTimer.unref();
  server.addHook("onClose", () => clearInterval(attachmentCleanupTimer));
  void cleanup();
}

const port = env.PORT;

const host = env.HOST;

// Bounded title requests abort and drain before the database pool closes.
server.addHook("onClose", async () => {
  await titleGenerator?.shutdown();
  await pool.end();
});

let closing: Promise<void> | undefined;

const shutdown = (signal: string) => {
  if (!closing) {
    server.log.info({ signal }, "Shutting down server");
    closing = server.close();
  }

  return closing;
};

process.once("SIGINT", () => void shutdown("SIGINT"));

process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.listen({ port, host });
  server.log.info({ port, host }, "Server running");
} catch (error) {
  const failure = publicFailure(error);
  server.log.error({ code: failure.code, statusCode: failure.statusCode }, "Server startup failed");
  await shutdown("startup-failure");
  process.exitCode = 1;
}
