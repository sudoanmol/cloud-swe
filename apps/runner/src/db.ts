import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@cloud-swe/db/schema/index";
import { createThreadStore } from "@cloud-swe/db/threads";

export function createRunnerDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required by runner");
  // Activities reserve one connection for the workspace lock and use the pool for writes.
  const pool = new Pool({
    connectionString,
    max: 16,
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
  return { store: createThreadStore(drizzle(pool, { schema })), pool, close: () => pool.end() };
}
