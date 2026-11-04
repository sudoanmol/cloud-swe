# Network-secret spike: transparent egress on E2B through a Worker

**Verdict: GO.** Run on 2026-11-03 (UTC) over 15 rounds on the `cloud-swe` E2B template, with a throwaway Worker, `cloud-swe-net-spike`, which was deleted afterwards.

- **Keys used:** a dummy secret everywhere. The project's real Anthropic, Firecrawl and E2B keys were also used, as Worker secrets only; the sandbox held only the placeholder.
- **Raw output:** [`results.log`](results.log), with the token, placeholder and dummy value redacted.
- **Cleanup:** every sandbox was killed, leaving 0 on the account.

The question: can a sandbox call real APIs with a placeholder key while the real key is swapped in outside the VM, with no SDK or agent changes? Design: [infra-decisions §9](../../docs/infra-decisions.md).

## How it works

- [`setup.sh`](setup.sh) runs as root. It:
  - creates a CA for this sandbox only and adds it to the system trust store;
  - sets `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `HTTPLIB2_CA_CERTS` and `DENO_CERT` in `/etc/profile.d`;
  - points each secret host at `127.0.0.1` and `::1` in `/etc/hosts`;
  - starts [`daemon.mjs`](daemon.mjs) in a respawn loop.
- **The daemon** (root, loopback `:443`):
  - terminates TLS with a leaf certificate for the SNI host and parses HTTP/1.1;
  - forwards each request to the Worker's `/net/<host>/<path>` with a token header;
  - checks a per-request end-of-body trailer;
  - bridges WebSocket upgrades.
- **[`worker.mjs`](worker.mjs):**
  - checks the token and host, and swaps the placeholder in request headers (Basic credentials decoded and re-encoded);
  - refuses redirects and redacts the value from response headers;
  - streams the body natively, then appends the trailer;
  - passes WebSockets through.

## Results

### Clients and SDKs

Each client called its real default host with the placeholder key and no config, unless noted.

| Client | Result |
| --- | --- |
| Node `fetch`, `https`, axios; Python `requests`, `httpx`, `aiohttp`, `httplib2`; Bun, Deno, Go `net/http`, Ruby `net/http`, Java `HttpClient`, PHP curl and streams; curl, wget; Rust reqwest (native-tls) | **Swap confirmed** by an echo server, and an ordinary public site still works |
| Node SDKs: `openai` 7.47, `@anthropic-ai/sdk` 1.4, `stripe` 23.1, `twilio` 6.2 (Basic), `@google/genai`, `groq-sdk`, `@mistralai/mistralai`, `cohere-ai`, `resend`, `@slack/web-api`, `@notionhq/client`, `replicate`, `@pinecone-database/pinecone` | **All reached the provider** and got its own auth error. OpenAI, Stripe and DeepSeek echo the masked swapped dummy (`sk_test_***…wxyz`) |
| Python SDKs: `openai` 3.42, `anthropic` 2.4, `google-genai`, `groq`, `mistralai`, `cohere`, `replicate` | **All reached the provider** |
| **Real keys:** Anthropic streaming (Node and Python SDKs, `claude-haiku-5-5`), Firecrawl `credit-usage`, E2B `GET /sandboxes` | **200 and complete**, with the sandbox holding only the placeholder |
| Python `stripe` 16.1 | Fails by default (ships its own CA). Works with `stripe.ca_bundle_path = os.environ["SSL_CERT_FILE"]` |
| Python `httplib2` | Fails without `HTTPLIB2_CA_CERTS`; works with it |
| Rust reqwest with rustls and bundled webpki roots | Fails TLS, as expected for bundled roots. This is a safe failure: only the placeholder is sent |
| Docker container in the sandbox | Bypasses `/etc/hosts` and sends the placeholder untouched (safe). It works with `--network host -v /etc/hosts:/etc/hosts:ro` plus the CA bundle mounted |
| A client doing DNS-over-HTTPS (`curl --doh-url`) | Bypasses the proxy and sends the placeholder untouched (safe) |
| Key in the query string (Google `?key=`) | Not swapped, by design. Google rejects it; use the `x-goog-api-key` header, which the SDKs do |

### Providers and hosts

| Check | Result |
| --- | --- |
| 44 provider APIs at their real hosts, each with its own auth header | All returned the provider's own auth error. None was blocked by Cloudflare or a firewall |
| Python `urllib` to httpbin | Cloudflare error 1010: httpbin's zone blocks Worker-originated requests with that user agent. No real API did this |

### Transport

| Check | Result |
| --- | --- |
| HTTP methods: GET, POST, PUT, PATCH, DELETE, HEAD | Pass; the swap works on each |
| Two `Set-Cookie` headers, gzip, `Expect: 100-continue` | Pass |
| Uploads | 5 MB and 20 MB pass |
| HTTP/2 | Clients that offer h2 fall back to HTTP/1.1 |
| 100 parallel requests | 100/100 swapped, in 1.6 s |
| Downloads | 100 MB five times in a row at 62–171 MB/s; direct was about 17 MB/s on the same sandbox earlier |
| SSE | Streams live; 150 events over 149 s with a maximum gap of 1.1 s |
| WebSockets (Node global `WebSocket`, Python `websockets`) | Work end to end through the daemon and Worker |
| Latency added per request | Median +28 to +50 ms. The first request to a host costs about +250 ms, for minting its leaf certificate |

### Lifecycle

| Check | Result |
| --- | --- |
| Daemon survives pause and resume | Yes, with the same process |
| Daemon killed | Respawned within 2 s |
| Package managers after setup (npm, pip, apt, cargo, the Bun, Deno and rustup installers) | Unaffected |
| Agent's access to the token and CA key | Root-only files, but the template's `user` has passwordless sudo and the docker group, so the agent can read them. The real key stays in the Worker |

## Problems found and fixed during the spike

These go into the product design.

1. **Truncation was hidden.** When the upstream dies mid-body, the Workers runtime still ends its response cleanly (proven with a `/diag` route: the Worker itself sees `Network connection lost`).
   - Fix: the daemon sends a random 16-byte nonce. The Worker appends `nonce + status byte` after the body.
   - The daemon holds back the last 17 bytes and resets the client connection unless the trailer is present and clean.
   - Bodiless replies (HEAD, 204, 304) skip the check.
   - Verified when the upstream is killed mid-stream and when the sandbox is paused mid-stream: the client sees a socket error, not a clean end.
2. **Worker CPU limit.** Piping the body through a JS `TransformStream` costs Worker CPU per chunk and failed large downloads with "exceeded CPU time limit". The native `IdentityTransformStream` costs none: 100 MB passed five times in a row.
3. **The daemon's error path ended a started response cleanly.** It now destroys the response once headers have been sent, and returns a 502 only before then.
4. **The daemon hop is identity-encoded.** `accept-encoding: identity` upstream, and no `content-encoding` on the trailer path, so the trailer can't be compressed into the body.

## Limits that remain

These are by design or set by the platform, and none of them leaks the key.

- **About 125 s to the first byte.** Through a Worker, a reply that starts later than about 125 s gets a Cloudflare 524 (90 s passed; 130 s and 250 s were cut at 125 s, while 130 s direct to E2B passed). This is Cloudflare's proxy read timeout, which only Enterprise can raise. Streaming calls are unaffected; a non-streaming call that thinks for over 2 minutes fails.
- **Clients with their own CA bundle or pinned certificates:** Python `stripe` (one-line fix), rustls with webpki roots, and any similar tool. They send only the placeholder.
- **Clients that skip the system resolver:** DNS-over-HTTPS, hardcoded IPs, Docker containers. The same is true: only the placeholder is sent.
- **Request signing (AWS SigV4) and keys in the body or query:** unsupported by design.
- **gRPC and HTTP/2-only clients:** the daemon offers HTTP/1.1 only, and Worker `fetch` can't carry gRPC trailers.
- **Cloudflare-fronted upstreams can apply bot rules to Worker egress.** Rare for real APIs.
- **Upstream echo:** a host that echoes request headers returns the real key in the body (httpbin did, with the dummy). Approved hosts must be trusted.

## Files

- **Runners**, run in this order: `run.mjs`, `followup.mjs`, `round3.mjs` to `round15.mjs`. Each later round reruns what an earlier one left open or broke.
- **[`clients/`](clients/):** the probes, plus `testserver.py`, the upstream used for slow replies, long SSE and kills.
- **Running them:** from `server/`, `node --env-file=<.env with E2B_API_KEY> ../experiments/network-secrets/<runner>`, with `SPIKE_WORKER_URL`, `SPIKE_TOKEN`, `PH` and `DUMMY` set and the Worker deployed from `wrangler.jsonc`. Each run is billed (cents).
