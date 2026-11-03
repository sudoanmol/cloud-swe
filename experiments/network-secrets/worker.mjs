// Spike Worker for the network-secret proxy: /net/<host>/<path>, authorized by a token header the in-VM daemon adds.
// Swaps the placeholder for the secret in request headers (Basic credentials decoded and re-encoded), refuses
// redirects and redacts the value from response headers. Throwaway: deployed as cloud-swe-net-spike, deleted after.

import hosts from './hosts.json';

const ALLOWED = new Set([...hosts.echo, ...Object.keys(hosts.providers)]);
// The spike's own slow/SSE test server runs in the sandbox behind an E2B port URL.
const allowed = (host) => ALLOWED.has(host) || /^\d{2,5}-[a-z0-9]{10,40}\.e2b\.app$/.test(host);
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'proxy-authenticate', 'host', 'x-spike-token', 'cdn-loop', 'x-real-ip', 'true-client-ip',
]);

const text = (status, body) => new Response(body + '\n', { status, headers: { 'content-type': 'text/plain' } });

function swap(value, placeholder, secret) {
  const basic = /^Basic\s+(\S+)$/i.exec(value);

  if (basic) {
    const decoded = atob(basic[1]);

    if (decoded.includes(placeholder)) return 'Basic ' + btoa(decoded.replaceAll(placeholder, secret));
  }

  return value.replaceAll(placeholder, secret);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Diagnostic: read an upstream body inside the Worker and report whether it ended cleanly or errored.
    const diag = /^\/diag\/([a-z0-9.-]{1,253})(\/.*)$/.exec(url.pathname);

    if (diag && request.headers.get('x-spike-token') === env.SPIKE_TOKEN && allowed(diag[1])) {
      const reply = await fetch(`https://${diag[1]}${diag[2]}${url.search}`);
      const reader = reply.body.getReader();
      let bytes = 0;

      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; }

        return Response.json({ upstreamStatus: reply.status, bytes, ended: 'clean' });
      } catch (error) {
        return Response.json({ upstreamStatus: reply.status, bytes, ended: 'error', error: String(error).slice(0, 200) });
      }
    }
    const match = /^\/net\/([a-z0-9.-]{1,253})(\/.*)?$/.exec(url.pathname);

    if (!match) return text(404, 'not found');

    if (request.headers.get('x-spike-token') !== env.SPIKE_TOKEN) return text(401, 'unauthorized');
    const host = match[1];

    if (!allowed(host)) return text(403, 'host not allowed');
    const secret = JSON.parse(env.REAL_SECRETS || '{}')[host] ?? env.DUMMY_SECRET;
    const dropped = new Set((request.headers.get('connection') ?? '').split(',').map((h) => h.trim().toLowerCase()));
    const headers = new Headers();

    for (const [name, value] of request.headers) {
      if (HOP.has(name) || dropped.has(name) || name.startsWith('cf-') || name.startsWith('x-forwarded-')) continue;
      headers.set(name, swap(value, env.PLACEHOLDER, secret));
    }

    const target = `https://${host}${match[2] ?? '/'}${url.search}`;

    // WebSockets: the runtime completes the upgrade upstream with the swapped headers and hands both ends over.
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      headers.set('upgrade', 'websocket');
      const reply = await fetch(target, { headers });

      if (!reply.webSocket) return text(502, `upstream refused the WebSocket (${reply.status})`);

      return new Response(null, { status: 101, webSocket: reply.webSocket });
    }

    const started = Date.now();
    let upstream;

    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      });
    } catch (error) {
      return text(502, 'upstream unreachable: ' + String(error).slice(0, 200));
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();

      return text(502, `upstream redirected (${upstream.status}) to ${upstream.headers.get('location') ?? '?'}`);
    }

    const out = new Headers();

    for (const [name, value] of upstream.headers) {
      if (HOP.has(name)) continue;
      out.append(name, value.replaceAll(secret, '[redacted]'));
    }

    out.set('x-spike-upstream-ms', String(Date.now() - started));

    if (!upstream.body) return new Response(null, { status: upstream.status, headers: out });

    // The runtime ends a response cleanly even when its body stream errors, so on the daemon hop the body is piped
    // natively (no per-chunk JS) and followed by the daemon's random nonce plus one status byte: 0 clean, 1 broken.
    const nonce = request.headers.get('x-spike-nonce');

    if (!/^[0-9a-f]{32}$/.test(nonce ?? '')) return new Response(upstream.body, { status: upstream.status, headers: out });
    out.delete('content-encoding');
    out.delete('content-length');
    // IdentityTransformStream is native: piping through it costs no Worker CPU, unlike a JS TransformStream.
    const { readable, writable } = new IdentityTransformStream();
    upstream.body
      .pipeTo(writable, { preventClose: true, preventAbort: true })
      .then(() => 0, (error) => { console.log('pipeTo rejected:', String(error), error?.stack?.split('\n')[1] ?? ''); return 1; })
      .then(async (status) => {
        const writer = writable.getWriter();
        const tail = new Uint8Array(17);
        tail.set(nonce.match(/../g).map((h) => parseInt(h, 16)));
        tail[16] = status;
        await writer.write(tail);
        await writer.close();
      })
      .catch(() => {});

    return new Response(readable, { status: upstream.status, headers: out });
  },
};
