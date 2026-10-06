/**
 * Joins a client WebSocket accepted by `Bun.serve` to an upstream one. The
 * upstream opens first, so the client handshake can echo its subprotocol;
 * messages it sends before the client opens are queued.
 */
export type Bridge = {
  upstream: WebSocket;
  pending: (string | ArrayBuffer)[];
  client?: Bun.ServerWebSocket<Bridge>;
  /** Sees each client message first; returning true consumes it instead of forwarding. */
  intercept?: (client: Bun.ServerWebSocket<Bridge>, message: string | Buffer) => boolean;
  onClose?: () => void;
};

/** Handshake headers the client's request carries but the upstream dial sets itself. */
export const websocketHandshakeHeaders = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
];

/** Reserved close codes (1005, 1006, 1015) cannot be sent; pass application codes through. */
function sendableCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

export function requestedProtocols(request: Request): string[] | undefined {
  return request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Resolves with the open upstream socket, or null when it fails to open. */
export async function openUpstream(
  url: string,
  init: { headers: Headers; protocols?: string[] },
): Promise<WebSocket | null> {
  // SAFETY: Bun's WebSocket constructor accepts `{ headers, protocols }`; the
  // DOM typings only declare the protocols argument.
  const socket = new WebSocket(url, {
    headers: Object.fromEntries(init.headers),
    protocols: init.protocols,
  } as never);

  socket.binaryType = "arraybuffer";

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 10_000);

    const settle = (value: boolean) => {
      clearTimeout(timer);
      resolve(value);
    };

    socket.addEventListener("open", () => settle(true), { once: true });
    socket.addEventListener("error", () => settle(false), { once: true });
    socket.addEventListener("close", () => settle(false), { once: true });
  });

  return opened ? socket : null;
}

export function createBridge(
  upstream: WebSocket,
  hooks: Pick<Bridge, "intercept" | "onClose"> = {},
): Bridge {
  const bridge: Bridge = { upstream, pending: [], ...hooks };

  upstream.addEventListener("message", (event) => {
    if (bridge.client) bridge.client.send(event.data);
    else bridge.pending.push(event.data);
  });
  upstream.addEventListener("close", (event) =>
    bridge.client?.close(sendableCode(event.code), event.reason),
  );

  return bridge;
}

export const bridgeHandlers: Bun.WebSocketHandler<Bridge> = {
  idleTimeout: 0,
  open(client) {
    client.data.client = client;

    for (const message of client.data.pending.splice(0)) client.send(message);

    if (client.data.upstream.readyState !== WebSocket.OPEN) client.close(1000, "Upstream closed");
  },
  message(client, message) {
    if (client.data.intercept?.(client, message)) return;

    if (client.data.upstream.readyState === WebSocket.OPEN) client.data.upstream.send(message);
  },
  close(client, code, reason) {
    client.data.upstream.close(sendableCode(code), reason);
    client.data.onClose?.();
  },
};
