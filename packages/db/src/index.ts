import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import * as schema from "./schema";

/** The application that creates the pool also owns its shutdown. */
export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export * from "./thread-contracts";

export * from "./threads";

export * from "./repository-url";

export * from "./question-contracts";

export * from "./question-store";

export * from "./attachment-objects";
