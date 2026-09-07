import { db } from "@cloud-swe/db";
import { createThreadStore } from "@cloud-swe/db/threads";

import { buildServer } from "./app";
import { z } from "zod";

const config = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default("0.0.0.0"),
    MAX_ACTIVE_RUNS: z.coerce.number().int().min(1).max(100).default(2),
    SSE_POLL_MS: z.coerce.number().int().min(10).default(200),
    SSE_HEARTBEAT_MS: z.coerce.number().int().min(100).default(15_000),
  })
  .parse(process.env);
const store = createThreadStore(db);
const server = buildServer({
  store,
  runLimit: config.MAX_ACTIVE_RUNS,
  pollMs: config.SSE_POLL_MS,
  heartbeatMs: config.SSE_HEARTBEAT_MS,
});
const port = config.PORT;
const host = config.HOST;

const shutdown = async (signal: string) => {
  server.log.info({ signal }, "Shutting down server");
  await server.close();
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
