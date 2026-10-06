import { afterAll, beforeAll, expect, test } from "bun:test";

import { bridgeHandlers, type Bridge } from "../src/bridge";
import { createPreviewProxy } from "../src/preview";

const slug = "0123456789abcdef0123456789abcdef";

const host = `3000-${slug}.p.test`;

/** Stands in for Modal's connect-token proxy plus the guest forwarder. */
const modal = Bun.serve({
  port: 0,
  fetch(request, server) {
    if (request.headers.get("authorization") !== "Bearer sandbox-token")
      return new Response("Unauthorized", { status: 401 });

    if (new URL(request.url).pathname === "/ws") {
      const upgraded = server.upgrade(request, {
        headers: { "sec-websocket-protocol": "vite-hmr" },
        data: undefined,
      });

      return upgraded ? undefined : new Response("bad", { status: 400 });
    }

    return Response.json(Object.fromEntries(request.headers));
  },
  websocket: {
    open(ws) {
      ws.send("ready");
    },
    message(ws, message) {
      ws.send(`echo:${message}`);
    },
  },
});

let connects = 0;

const touches: string[] = [];

let running = true;

const token = "sandbox-token";

const proxy = createPreviewProxy({
  domain: "p.test",
  resolve: async (value) =>
    running && value === slug ? { threadId: "thread-1", providerId: "sb-1" } : null,
  connect: async () => {
    connects += 1;

    return { url: `http://127.0.0.1:${modal.port}`, token };
  },
  touch: async (threadId) => {
    touches.push(threadId);
  },
});

let gateway: Bun.Server<Bridge>;

beforeAll(() => {
  gateway = Bun.serve<Bridge, never>({
    port: 0,
    fetch: (request, server) => proxy.fetch(request, server),
    websocket: bridgeHandlers,
  });
});

afterAll(() => {
  gateway.stop(true);
  modal.stop(true);
});

const visit = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${gateway.port}${path}`, { headers: { host, ...headers } });

test("matches only preview hosts of its domain", () => {
  expect(proxy.matches(new Request("http://x/", { headers: { host } }))).toBe(true);
  expect(proxy.matches(new Request("http://x/", { headers: { host: "gateway.test" } }))).toBe(
    false,
  );
});

test("forwards HTTP with the sandbox token and the visitor's own Authorization set aside", async () => {
  const response = await visit("/api/x?y=1", { authorization: "Bearer app" });
  // SAFETY: the stand-in upstream answers with its request headers as a JSON object.
  const seen = (await response.json()) as Record<string, string>;

  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(seen.authorization).toBe("Bearer sandbox-token");
  expect(seen["x-cloud-swe-authorization"]).toBe("Bearer app");
  expect(seen["x-cloud-swe-port"]).toBe("3000");
  expect(seen["x-forwarded-host"]).toBe(host);

  await visit("/again");
  expect(connects).toBe(1);
  expect(touches).toEqual(["thread-1"]);
});

test("bridges WebSockets with the upstream subprotocol", async () => {
  // SAFETY: Bun's WebSocket constructor accepts `{ headers, protocols }`.
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, {
    headers: { host },
    protocols: ["vite-hmr"],
  } as never);

  const messages: string[] = [];

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => socket.send("hi");
    socket.onmessage = (event) => {
      messages.push(String(event.data));

      if (messages.length === 2) resolve();
    };

    socket.onerror = () => reject(new Error("socket failed"));
  });

  expect(socket.protocol).toBe("vite-hmr");
  expect(messages).toEqual(["ready", "echo:hi"]);
  socket.close();
});

test("answers 503 while the workspace is not running", async () => {
  running = false;
  const response = await visit("/");
  running = true;

  expect(response.status).toBe(503);
  expect(await response.text()).toContain("not running");
});

test("re-mints a rejected token and retries a read", async () => {
  let minted = 0;

  const refreshing = createPreviewProxy({
    domain: "p.test",
    resolve: async () => ({ threadId: "thread", providerId: "sandbox" }),
    connect: async () => ({
      url: `http://127.0.0.1:${modal.port}`,
      token: ++minted === 1 ? "expired" : "sandbox-token",
    }),
    touch: async () => undefined,
  });

  const server = Bun.serve<Bridge, never>({
    port: 0,
    fetch: (request, server) => refreshing.fetch(request, server),
    websocket: bridgeHandlers,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}`, { headers: { host } });
    expect(response.status).toBe(200);
    expect(minted).toBe(2);
  } finally {
    await server.stop(true);
  }
});
