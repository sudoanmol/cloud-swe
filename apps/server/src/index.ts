import { createModelCredentialStore } from "@cloud-swe/db/model-credentials";
import {
  createAuth,
  githubCredentialsFromEnv,
  requireGithubAppOAuthInProduction,
} from "@cloud-swe/auth";
import { createDb } from "@cloud-swe/db";
import { createThreadStore } from "@cloud-swe/db/threads";
import { publicFailure } from "@cloud-swe/db/public-failure";
import { env as databaseEnv } from "@cloud-swe/env/database";
import { env as authEnv } from "@cloud-swe/env/auth";
import { env } from "@cloud-swe/env/server";
import { Pool } from "pg";
import { env as gitEnv } from "@cloud-swe/env/git";
import { createGitStore, gitError } from "@cloud-swe/db/git-store";
import { createGithubClient } from "@cloud-swe/api/github";
import { createGitBundles } from "@cloud-swe/api/git-bundles";

import { buildServer } from "./app";

const pool = new Pool({
  connectionString: databaseEnv.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});

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
    const session = await auth.api.getSession({ headers });

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

const store = createThreadStore(database, {
  primaryGithubAccountId: env.PRIMARY_GITHUB_ACCOUNT_ID,
});

const modelEncryptionKey = env.MODEL_CREDENTIALS_ENCRYPTION_KEY;

if (env.RUNNER_EXECUTION_MODE === "pi" && !modelEncryptionKey)
  throw new Error("MODEL_CREDENTIALS_ENCRYPTION_KEY is required for Pi execution");

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
  git: gitConfigured
    ? {
        store: gitStore,
        github: githubClient,
        bundles: gitBundles,
        secret: gitEnv.GIT_BROKER_SECRET!,
        publicUrl: gitEnv.GIT_BROKER_URL!.replace(/\/$/, ""),
        maxBytes: gitEnv.GIT_BROKER_MAX_BYTES,
      }
    : undefined,
  auth: authProvider,
  store,
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

    return {
      trusted: result.rows.length > 0,
      owner: result.rows.some((account) => account.account_id === env.PRIMARY_GITHUB_ACCOUNT_ID),
    };
  },
});

const port = env.PORT;

const host = env.HOST;

server.addHook("onClose", () => pool.end());

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
