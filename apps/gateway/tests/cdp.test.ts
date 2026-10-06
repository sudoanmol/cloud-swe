import { afterAll, beforeAll, expect, test } from "bun:test";
import { signRelayCapability } from "@cloud-swe/db/browser-relay";
import type { BrowserOwner } from "@cloud-swe/db/pi-events";

import { bridgeHandlers, type Bridge } from "../src/bridge";
import { createCdpRelay, userControlMessage } from "../src/cdp";

const secret = "s".repeat(32);

const threadId = "00000000-0000-4000-8000-000000000001";

/** Stands in for the Kernel browser: answers every CDP command with its method. */
const kernel = Bun.serve({
  port: 0,
  fetch: (request, server) =>
    server.upgrade(request, { data: undefined }) ? undefined : new Response("bad", { status: 400 }),
  websocket: {
    message(ws, message) {
      const { id, method } = JSON.parse(String(message));

      if (method === "Test.disconnect") {
        ws.close(4000, "Provider reconnect required");

        return;
      }

      ws.send(JSON.stringify({ id, result: { method } }));
    },
  },
});

let running = true;

let ownerFails = false;

let owner: BrowserOwner = "agent";

const activity: boolean[] = [];

const relay = createCdpRelay({
  secret,
  running: async (id, generation) => running && id === threadId && generation === 1,
  browser: async () => `ws://127.0.0.1:${kernel.port}`,
  owner: async () => {
    if (ownerFails) throw new Error("Database unavailable");

    return owner;
  },
  activity: async (_id, active) => {
    activity.push(active);
  },
  quietMs: 300,
  ownerPollMs: 10,
});

let gateway: Bun.Server<Bridge>;

beforeAll(() => {
  gateway = Bun.serve<Bridge, never>({
    port: 0,
    fetch: (request, server) => relay.fetch(request, server),
    websocket: bridgeHandlers,
  });
});

afterAll(() => {
  gateway.stop(true);
  kernel.stop(true);
});

const capability = (generation: number) =>
  signRelayCapability(secret, { threadId, generation, expires: Date.now() + 60_000 });

async function connect(cap: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/cdp?cap=${cap}`);
  const replies: unknown[] = [];

  socket.onmessage = (event) => replies.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("relay refused"));
  });

  const send = async (id: number, sessionId?: string) => {
    socket.send(JSON.stringify({ id, method: "Page.navigate", sessionId }));
    await Bun.sleep(30);

    return replies.at(-1);
  };

  return { socket, send };
}

test("refuses forged capabilities and stopped workspaces", async () => {
  const forged = await fetch(`http://127.0.0.1:${gateway.port}/cdp?cap=nope`);
  const stale = await fetch(`http://127.0.0.1:${gateway.port}/cdp?cap=${capability(2)}`);

  expect(forged.status).toBe(401);
  expect(stale.status).toBe(403);
});

test("relays the agent while it drives and refuses it while the user does", async () => {
  const { socket, send } = await connect(capability(1));

  expect(await send(1)).toEqual({ id: 1, result: { method: "Page.navigate" } });

  owner = "user";
  await Bun.sleep(30);
  expect(await send(2, "session-a")).toEqual({
    id: 2,
    sessionId: "session-a",
    error: { code: -32000, message: userControlMessage },
  });

  owner = "agent";
  await Bun.sleep(30);
  expect(await send(3)).toEqual({ id: 3, result: { method: "Page.navigate" } });

  // One burst of commands is one activity edge each way.
  expect(activity).toEqual([true]);
  await Bun.sleep(400);
  expect(activity).toEqual([true, false]);
  socket.close();
});

test("revokes an open relay when its workspace stops", async () => {
  const { socket } = await connect(capability(1));

  const closed = new Promise<number>(
    (resolve) => (socket.onclose = (event) => resolve(event.code)),
  );

  running = false;
  expect(await closed).toBe(4001);
  running = true;
});

test("ownership lookup failures block commands until the database recovers", async () => {
  const { socket, send } = await connect(capability(1));
  ownerFails = true;
  await Bun.sleep(30);
  expect(await send(8)).toMatchObject({ error: { message: userControlMessage } });
  ownerFails = false;
  await Bun.sleep(30);
  expect(await send(9)).toEqual({ id: 9, result: { method: "Page.navigate" } });
  socket.close();
});

test("a provider disconnect closes the client, which can reconnect to the same browser", async () => {
  const first = await connect(capability(1));

  const closed = new Promise<number>(
    (resolve) => (first.socket.onclose = (event) => resolve(event.code)),
  );

  first.socket.send(JSON.stringify({ id: 10, method: "Test.disconnect" }));
  expect(await closed).toBe(4000);
  const second = await connect(capability(1));
  expect(await second.send(11)).toEqual({ id: 11, result: { method: "Page.navigate" } });
  second.socket.close();
});
