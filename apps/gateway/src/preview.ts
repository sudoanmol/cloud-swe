import { parsePreviewHost } from "@cloud-swe/db/previews";

import {
  type Bridge,
  createBridge,
  openUpstream,
  requestedProtocols,
  websocketHandshakeHeaders,
} from "./bridge";

export interface PreviewOptions {
  domain: string;
  /** The running sandbox behind a slug; null while paused, starting, or deleted. */
  resolve(slug: string): Promise<{ threadId: string; providerId: string } | null>;
  /** A Modal connect token for the sandbox's preview forwarder. */
  connect(providerId: string): Promise<{ url: string; token: string }>;
  /** Records preview use, which defers the idle pause. */
  touch(threadId: string): Promise<void>;
  now?: () => number;
}

const hopByHop = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
];

// ponytail: fixed TTL; connect-token lifetime is undocumented, so re-mint well inside it.
const tokenTtlMs = 10 * 60_000;

const touchIntervalMs = 60_000;

const asleep = `<!doctype html><meta charset="utf-8"><title>Preview not running</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>This preview is not running</h1>
<p>Its workspace is paused or starting. Open the thread to resume it, then reload this page.</p>`;

export function createPreviewProxy(options: PreviewOptions) {
  const now = options.now ?? Date.now;

  const tokens = new Map<
    string,
    { expires: number; creds: Promise<{ url: string; token: string }> }
  >();

  const touched = new Map<string, number>();

  function credentials(providerId: string) {
    const cached = tokens.get(providerId);

    if (cached && cached.expires > now()) return cached.creds;
    const creds = options.connect(providerId);
    tokens.set(providerId, { expires: now() + tokenTtlMs, creds });
    creds.catch(() => tokens.delete(providerId));

    return creds;
  }

  function touch(threadId: string) {
    if ((touched.get(threadId) ?? 0) > now() - touchIntervalMs) return;
    touched.set(threadId, now());
    void options.touch(threadId).catch(() => touched.delete(threadId));
  }

  function upstreamHeaders(request: Request, host: string, port: number, token: string) {
    const headers = new Headers(request.headers);

    for (const name of hopByHop) headers.delete(name);
    // Modal reads Authorization; the forwarder restores the visitor's own value.
    const authorization = headers.get("authorization");
    headers.delete("authorization");
    headers.delete("x-cloud-swe-authorization");

    if (authorization) headers.set("x-cloud-swe-authorization", authorization);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-cloud-swe-port", String(port));
    headers.set("x-forwarded-host", host);
    headers.set("x-forwarded-proto", "https");

    return headers;
  }

  return {
    /** True when the request's Host is a preview of this gateway's domain. */
    matches(request: Request): boolean {
      return parsePreviewHost(request.headers.get("host") ?? "", options.domain) !== null;
    },

    async fetch(request: Request, server: Bun.Server<Bridge>): Promise<Response | undefined> {
      const host = request.headers.get("host") ?? "";
      const preview = parsePreviewHost(host, options.domain);

      if (!preview) return new Response("Not found", { status: 404 });
      const target = await options.resolve(preview.slug);

      if (!target)
        return new Response(asleep, {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8", "retry-after": "10" },
        });

      touch(target.threadId);
      let { url, token } = await credentials(target.providerId);
      const incoming = new URL(request.url);
      const path = `${incoming.pathname}${incoming.search}`;
      const headers = upstreamHeaders(request, host.replace(/:\d+$/, ""), preview.port, token);

      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        for (const name of websocketHandshakeHeaders) headers.delete(name);

        let upstream = await openUpstream(`${url.replace(/^http/, "ws")}${path}`, {
          headers,
          protocols: requestedProtocols(request),
        });

        if (!upstream) {
          tokens.delete(target.providerId);
          ({ url, token } = await credentials(target.providerId));
          headers.set("authorization", `Bearer ${token}`);
          upstream = await openUpstream(`${url.replace(/^http/, "ws")}${path}`, {
            headers,
            protocols: requestedProtocols(request),
          });
        }

        if (!upstream) return new Response("Preview WebSocket failed", { status: 502 });

        const upgraded = server.upgrade(request, {
          data: createBridge(upstream),
          headers: upstream.protocol ? { "sec-websocket-protocol": upstream.protocol } : undefined,
        });

        if (upgraded) return undefined;
        upstream.close();

        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      let upstream = await fetch(`${url}${path}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        decompress: false,
      });

      if (
        (upstream.status === 401 || upstream.status === 403) &&
        !upstream.headers.has("x-cloud-swe-forwarded")
      ) {
        tokens.delete(target.providerId);
        const renewed = await credentials(target.providerId);

        // Never replay a mutation or an already-consumed request body.
        if (request.method === "GET" || request.method === "HEAD") {
          await upstream.body?.cancel();
          headers.set("authorization", `Bearer ${renewed.token}`);
          upstream = await fetch(`${renewed.url}${path}`, {
            method: request.method,
            headers,
            redirect: "manual",
            decompress: false,
          });
        }
      }

      const response = new Response(upstream.body, upstream);
      response.headers.delete("x-cloud-swe-forwarded");

      // The slug is the preview's only secret; keep it out of third-party Referers.
      if (!response.headers.has("referrer-policy"))
        response.headers.set("referrer-policy", "no-referrer");

      return response;
    },
  };
}
