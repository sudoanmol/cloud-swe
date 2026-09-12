import { env } from "@cloud-swe/env/runner";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@cloud-swe/db/schema/index";
import { createThreadStore } from "@cloud-swe/db/threads";

export function createRunnerDatabase() {
  // Activities reserve one connection for the workspace lock and use the pool for writes.
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 2 * env.RUNNER_ACTIVITY_CONCURRENCY + 4,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });

  pool.on("error", () => {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        message: "PostgreSQL idle connection failed; pool will reconnect",
      }) + "\n",
    );
  });

  return {
    store: createThreadStore(drizzle(pool, { schema }), {
      primaryGithubAccountId: env.PRIMARY_GITHUB_ACCOUNT_ID,
    }),
    pool,
    close: () => pool.end(),
  };
}
