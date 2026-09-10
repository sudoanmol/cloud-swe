import { createAuth } from "@cloud-swe/auth";
import { createDb } from "@cloud-swe/db";
import { createThreadStore } from "@cloud-swe/db/threads";
import { env as databaseEnv } from "@cloud-swe/env/database";
import { env as authEnv } from "@cloud-swe/env/auth";
import { env } from "@cloud-swe/env/server";
import { Pool } from "pg";

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
const auth = createAuth({
  database,
  secret: authEnv.BETTER_AUTH_SECRET,
  baseURL: authEnv.BETTER_AUTH_URL,
  trustedOrigins: [env.CORS_ORIGIN],
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

const server = buildServer({
  auth: authProvider,
  store: createThreadStore(database),
  trustedOrigins: [env.CORS_ORIGIN],
  runLimit: env.MAX_ACTIVE_RUNS,
  pollMs: env.SSE_POLL_MS,
  heartbeatMs: env.SSE_HEARTBEAT_MS,
  nodeEnv: env.NODE_ENV,
  allowUnverifiedCompute:
    env.NODE_ENV !== "production" && process.env.ALLOW_UNVERIFIED_COMPUTE === "true",
  isTrustedComputeUser: async (userId) => {
    const result = await pool.query(
      'select 1 from "account" where "user_id" = $1 and "provider_id" = $2 limit 1',
      [userId, "github"],
    );
    return (result.rowCount ?? 0) > 0;
  },
});
const port = env.PORT;
const host = env.HOST;

const shutdown = async (signal: string) => {
  server.log.info({ signal }, "Shutting down server");
  await server.close();
  await pool.end();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.listen({ port, host });
  server.log.info({ port, host }, "Server running");
} catch (error) {
  server.log.error(error);
  await pool.end();
  process.exitCode = 1;
}
