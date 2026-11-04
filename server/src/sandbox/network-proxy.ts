/**
 * Path: server/src/sandbox/network-proxy.ts
 * Used by: server/src/index.ts.
 * Purpose: The /net route the egress daemon forwards to: checks the session's network capability and the host, swaps each placeholder for its network secret in the named header, relays the reply with the value redacted from its headers, and appends the end-of-body trailer. Mounted before bearer auth, like the Git proxy.
 */

import { Hostname } from '@cloud-swe/protocol/environments';
import type { Hono } from 'hono';

import { credentialsStub, type Env, threadStub } from '../env.ts';

const PATH = /^\/net\/([0-9a-f-]{36})\/([a-z0-9.-]{1,253})(\/.*)?$/;

const TOKEN_HEADER = 'x-cloud-swe-network-token';

const NONCE_HEADER = 'x-cloud-swe-nonce';

const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'host',
]);

// Routing and identity headers the Worker's own edge adds, plus ours; none reaches the upstream.
const DROPPED = new Set(['x-real-ip', 'true-client-ip', 'cdn-loop', TOKEN_HEADER, NONCE_HEADER]);

const text = (status: number, body: string) =>
  new Response(body + '\n', { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

type Swap = { header: string; placeholder: string; value: string };

/** A Basic credential is decoded, swapped and re-encoded; anything else is swapped in place. */
function swapped(value: string, swap: Swap): string {
  const basic = /^Basic\s+(\S+)$/i.exec(value)?.[1];

  if (basic) {
    try {
      const decoded = atob(basic);

      if (decoded.includes(swap.placeholder)) return 'Basic ' + btoa(decoded.replaceAll(swap.placeholder, swap.value));
    } catch {
      // Not base64: fall through to a plain swap.
    }
  }

  return value.replaceAll(swap.placeholder, swap.value);
}

function upstreamHeaders(request: Request, swaps: Swap[], websocket: boolean): Headers {
  const listed = new Set((request.headers.get('connection') ?? '').split(',').map((name) => name.trim().toLowerCase()));

  const headers = new Headers();

  request.headers.forEach((value, name) => {
    if (HOP.has(name) || DROPPED.has(name) || listed.has(name)) return;

    if (name.startsWith('cf-') || name.startsWith('x-forwarded-')) return;
    // Only the header each secret names; the query and body are never touched.
    const own = swaps.filter((swap) => swap.header.toLowerCase() === name);
    headers.set(name, own.reduce(swapped, value));
  });

  if (websocket) headers.set('upgrade', 'websocket');

  return headers;
}

const redacted = (value: string, swaps: Swap[]) =>
  swaps.reduce((text, swap) => text.replaceAll(swap.value, '[redacted]'), value);

function replyHeaders(upstream: Response, swaps: Swap[]): Headers {
  const headers = new Headers();

  // Each Set-Cookie arrives on its own; other repeated headers arrive joined.
  upstream.headers.forEach((value, name) => {
    if (HOP.has(name) || name === 'content-encoding' || name === 'content-length') return;
    // Best effort: an upstream that echoes the key in its body still returns it.
    headers.append(name, redacted(value, swaps));
  });

  return headers;
}

/**
 * The Workers runtime ends a response cleanly even when the upstream body breaks, so after the body comes the daemon's
 * nonce and a status byte (0 clean, 1 broken). The native IdentityTransformStream costs no Worker CPU per chunk.
 */
function withTrailer(body: ReadableStream<Uint8Array>, nonce: string): ReadableStream<Uint8Array> {
  const { readable, writable } = new IdentityTransformStream();
  const trailer = new Uint8Array(17);
  trailer.set((nonce.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

  void body
    .pipeTo(writable, { preventClose: true, preventAbort: true })
    .then(
      () => 0,
      () => 1,
    )
    .then(async (status) => {
      trailer[16] = status;
      const writer = writable.getWriter();
      await writer.write(trailer);
      await writer.close();
    })
    .catch(() => undefined);

  return readable;
}

export function networkProxyRoutes(app: Hono<{ Bindings: Env }>) {
  // oxlint-disable-next-line eslint/complexity -- the one path every proxied request takes, read top to bottom.
  app.all('/net/*', async (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    const [, sessionId, host, path] = PATH.exec(url.pathname) ?? [];

    if (!sessionId || !host || !Hostname.safeParse(host).success) return text(404, 'Not found');
    const websocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    const nonce = request.headers.get(NONCE_HEADER) ?? '';

    if (!websocket && !/^[0-9a-f]{32}$/.test(nonce)) return text(400, 'Missing or invalid nonce');
    const token = request.headers.get(TOKEN_HEADER);

    if (!token) return text(401, 'Missing network token');
    let swaps: Swap[] | null;

    try {
      const authorization = await threadStub(c.env, sessionId).authorizeNetwork(token);

      if (!authorization.ok) {
        return authorization.reason === 'unavailable'
          ? text(503, 'Network access could not be checked; try again')
          : text(401, 'Network token is invalid, or its sandbox was replaced');
      }

      swaps = authorization.environment
        ? await credentialsStub(c.env).networkSwaps(authorization.environment, host)
        : null;
    } catch {
      // Fail closed.
      return text(503, 'Network access could not be checked; try again');
    }

    if (!swaps) return text(403, 'No network secret allows this host');
    const target = `https://${host}${path ?? '/'}${url.search}`;
    const headers = upstreamHeaders(request, swaps, websocket);

    if (websocket) {
      // Manual, as below: a redirect is not a WebSocket, so it is refused rather than followed with the key.
      const reply = await fetch(target, { headers, redirect: 'manual' }).catch(() => undefined);

      if (!reply?.webSocket) return text(502, 'Upstream refused the WebSocket');
      // The client rejects the upgrade unless it sees the subprotocol the upstream chose.
      const protocol = reply.headers.get('sec-websocket-protocol');
      const replied = protocol ? { 'Sec-WebSocket-Protocol': redacted(protocol, swaps) } : undefined;

      return new Response(null, { status: 101, webSocket: reply.webSocket, headers: replied });
    }

    let upstream: Response;

    try {
      // Never retried: the request may have reached the upstream.
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      });
    } catch {
      return text(502, 'Upstream unreachable');
    }

    // Following a redirect could carry the key to another host.
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();

      return text(502, 'upstream redirected');
    }

    const replied = replyHeaders(upstream, swaps);

    if (!upstream.body) return new Response(null, { status: upstream.status, headers: replied });

    return new Response(withTrailer(upstream.body, nonce), { status: upstream.status, headers: replied });
  });
}
