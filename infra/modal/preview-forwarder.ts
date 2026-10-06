// Guest side of previews. Modal routes connect-token traffic only to sockets
// bound to 0.0.0.0, and dev servers usually bind loopback. The gateway sends
// every preview request here with the target port, and this forwards it to
// loopback with the preview hostname as Host, so host checks (Vite's
// allowedHosts) and Host-derived URLs see the public origin.
//
// Standalone on purpose: it runs from the image with no dependencies. The
// port matches `previewForwarderPort` in packages/db/src/previews.ts.

import { createConnection } from "node:net";

const listenPort = 7999;

const loopbacks = ["127.0.0.1", "[::1]"];

const hopByHop = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "x-cloud-swe-port",
];

const websocketHandshake = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
];

type Bridge = {
  upstream: WebSocket;
  /** Upstream messages that arrive before the client socket opens. */
  pending: (string | ArrayBuffer | Uint8Array)[];
  client?: Bun.ServerWebSocket<Bridge>;
};

function targetPort(request: Request): number | null {
  const port = Number(request.headers.get("x-cloud-swe-port"));

  return Number.isInteger(port) && port >= 1 && port <= 65_535 && port !== listenPort ? port : null;
}

function upstreamHeaders(request: Request, omit: readonly string[]): Headers {
  const headers = new Headers(request.headers);

  for (const name of omit) headers.delete(name);
  const host = request.headers.get("x-forwarded-host");

  if (host) headers.set("host", host);
  // The gateway authenticates to Modal with Authorization and moves the
  // visitor's own header aside; restore it for the app.
  const authorization = request.headers.get("x-cloud-swe-authorization");
  headers.delete("authorization");
  headers.delete("x-cloud-swe-authorization");
  headers.delete("x-verified-user-data");

  if (authorization) headers.set("authorization", authorization);

  return headers;
}

/** Reserved close codes (1005, 1006, 1015) cannot be sent; pass application codes through. */
function sendableCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

async function acceptsTcp(address: string, port: number): Promise<boolean> {
  // Probe before consuming a streamed body. Never replay an HTTP mutation.
  return new Promise((resolve) => {
    const socket = createConnection({ host: address.replace(/[[\]]/g, ""), port });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Opens the loopback socket first, so the client handshake can echo the chosen subprotocol. */
async function dialWebSocket(port: number, path: string, request: Request): Promise<WebSocket> {
  const protocols = request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const headers = upstreamHeaders(request, [...hopByHop, ...websocketHandshake]);

  for (const address of loopbacks) {
    // SAFETY: Bun's WebSocket constructor accepts `{ headers, protocols }`; the
    // DOM typings only declare the protocols argument.
    const socket = new WebSocket(`ws://${address}:${port}${path}`, {
      headers: Object.fromEntries(headers),
      protocols,
    } as never);

    socket.binaryType = "arraybuffer";

    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener("open", () => resolve(true), { once: true });
      socket.addEventListener("error", () => resolve(false), { once: true });
    });

    if (opened) return socket;
  }

  throw new Error("upstream WebSocket failed");
}

const server = Bun.serve<Bridge, never>({
  hostname: "0.0.0.0",
  port: listenPort,
  idleTimeout: 0,
  async fetch(request, server) {
    const port = targetPort(request);

    if (!port) return new Response("Missing preview port", { status: 400 });
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      let upstream: WebSocket;

      try {
        upstream = await dialWebSocket(port, path, request);
      } catch {
        return new Response(`Nothing accepted a WebSocket on port ${port}`, { status: 502 });
      }

      const bridge: Bridge = { upstream, pending: [] };
      upstream.addEventListener("message", (event) => {
        if (bridge.client) bridge.client.send(event.data);
        else bridge.pending.push(event.data);
      });
      upstream.addEventListener("close", (event) =>
        bridge.client?.close(sendableCode(event.code), event.reason),
      );

      const upgraded = server.upgrade(request, {
        data: bridge,
        headers: upstream.protocol ? { "sec-websocket-protocol": upstream.protocol } : undefined,
      });

      if (upgraded) return undefined;
      upstream.close();

      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;

    for (const address of loopbacks) {
      if (!(await acceptsTcp(address, port))) continue;

      try {
        const response = await fetch(`http://${address}:${port}${path}`, {
          method: request.method,
          headers: upstreamHeaders(request, hopByHop),
          body,
          redirect: "manual",
          decompress: false,
        });

        response.headers.set("x-cloud-swe-forwarded", "1");

        return response;
      } catch {
        break;
      }
    }

    return new Response(`Nothing is listening on port ${port} in the workspace`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
  websocket: {
    open(client) {
      client.data.client = client;

      for (const message of client.data.pending.splice(0)) client.send(message);
    },
    message(client, message) {
      if (client.data.upstream.readyState === WebSocket.OPEN) client.data.upstream.send(message);
    },
    close(client, code, reason) {
      client.data.upstream.close(sendableCode(code), reason);
    },
  },
});

console.log(`preview forwarder listening on ${server.hostname}:${server.port}`);
