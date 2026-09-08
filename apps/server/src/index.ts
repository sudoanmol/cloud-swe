import { db } from "@cloud-swe/db";
import { createThreadStore } from "@cloud-swe/db/threads";
import { env } from "@cloud-swe/env/server";

import { buildServer } from "./app";

const store = createThreadStore(db);
const server = buildServer({
  store,
  runLimit: env.MAX_ACTIVE_RUNS,
  pollMs: env.SSE_POLL_MS,
  heartbeatMs: env.SSE_HEARTBEAT_MS,
});
const port = env.PORT;
const host = env.HOST;

const shutdown = async (signal: string) => {
  server.log.info({ signal }, "Shutting down server");
  await server.close();
  await db.$client.end();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.listen({ port, host });
  server.log.info({ port, host }, "Server running");
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
