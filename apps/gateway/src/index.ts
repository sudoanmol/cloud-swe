import { createDb } from "@cloud-swe/db";
import { createAgentBrowsers } from "@cloud-swe/db/agent-browsers";
import { previewForwarderPort } from "@cloud-swe/db/previews";
import { reachableSandbox } from "@cloud-swe/db/thread-contracts";
import { createThreadStore } from "@cloud-swe/db/threads";
import { browserConfig } from "@cloud-swe/env/browser";
import { env as databaseEnv } from "@cloud-swe/env/database";
import { env } from "@cloud-swe/env/gateway";
import { env as previewEnv } from "@cloud-swe/env/preview";
import { ModalClient } from "modal";
import { Pool, type QueryConfig } from "pg";
import pino from "pino";

import { bridgeHandlers, type Bridge } from "./bridge";
import { createCdpRelay } from "./cdp";
import { createPreviewProxy } from "./preview";

/**
 * Untrusted-traffic proxies, kept out of the API process: previews of sandbox
 * ports on `*.<PREVIEW_DOMAIN>`, and the sandbox's CDP relay at `/cdp`.
 */
const logger = pino({ name: "cloud-swe-gateway", level: env.LOG_LEVEL });

const domain = previewEnv.PREVIEW_DOMAIN;

const browser = browserConfig();

if (!domain && !browser)
  throw new Error("Configure PREVIEW_DOMAIN or the hosted browser to run the gateway");

const pool = new Pool({
  connectionString: databaseEnv.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", () => logger.error("PostgreSQL idle connection failed; pool will reconnect"));

const store = createThreadStore(createDb(pool));

if (domain && (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET))
  throw new Error("Previews require MODAL_TOKEN_ID and MODAL_TOKEN_SECRET");

const modal =
  domain &&
  new ModalClient({
    tokenId: env.MODAL_TOKEN_ID,
    tokenSecret: env.MODAL_TOKEN_SECRET,
    environment: env.MODAL_ENVIRONMENT,
  });

const previews =
  domain &&
  modal &&
  createPreviewProxy({
    domain,
    resolve: (slug) => store.resolvePreview(slug),
    connect: async (providerId) => {
      const sandbox = await modal.sandboxes.fromId(providerId);

      return sandbox.createConnectToken({ port: previewForwarderPort });
    },
    touch: (threadId) => store.touchWorkspaceReview(threadId),
  });

const relay =
  browser &&
  (() => {
    const browsers = createAgentBrowsers({
      apiKey: browser.kernelApiKey,
      idleSeconds: browser.idleSeconds,
    });

    return createCdpRelay({
      secret: browser.relaySecret,
      running: async (threadId, generation) => {
        const workspace = await store.readWorkspace(threadId);

        return Boolean(reachableSandbox(workspace) && workspace?.generation === generation);
      },
      browser: async (threadId) => (await browsers.ensure(threadId)).cdpUrl,
      owner: (threadId) => store.readBrowserOwner(threadId),
      activity: (threadId, active) => store.recordBrowserActivity(threadId, active),
    });
  })();

// pg reads a per-query query_timeout; @types/pg only declares it on the pool. A timed-out
// probe errors, so the pool discards its connection instead of reusing it.
const readinessProbe: QueryConfig & { query_timeout: number } = {
  text: "select 1",
  query_timeout: 2_000,
};

async function ready() {
  try {
    await pool.query(readinessProbe);

    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}

const server = Bun.serve<Bridge, never>({
  hostname: env.GATEWAY_HOST,
  port: env.GATEWAY_PORT,
  // Dev servers stream (SSE, slow builds); Bun's default would cut them at 10s.
  idleTimeout: 0,
  async fetch(request, server) {
    try {
      if (previews && previews.matches(request)) return await previews.fetch(request, server);
      const path = new URL(request.url).pathname;

      if (relay && path === "/cdp") return await relay.fetch(request, server);

      if (path === "/health") return Response.json({ status: "ok" });

      if (path === "/ready") return await ready();

      return new Response("Not found", { status: 404 });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.name : "UnknownError" },
        "Gateway request failed",
      );

      return new Response("Gateway request failed", { status: 502 });
    }
  },
  websocket: bridgeHandlers,
});

logger.info({ host: server.hostname, port: server.port }, "Gateway listening");

async function shutdown() {
  await server.stop();
  await pool.end();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());

process.once("SIGTERM", () => void shutdown());
