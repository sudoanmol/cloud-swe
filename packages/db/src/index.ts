import { env } from "@cloud-swe/env/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export function createDb() {
  const pool = new Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
  pool.on("error", () => {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        message: "PostgreSQL idle connection failed; pool will reconnect",
      }) + "\n",
    );
  });
  return drizzle(pool, { schema });
}

export const db = createDb();

export * from "./thread-contracts";
export * from "./threads";
