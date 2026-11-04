# How the network-secret swap works

This guide explains, in plain words, how a network secret gets from your environment to an API like OpenAI without ever being inside the sandbox. It follows one request from start to finish and points at the code for each step.

It explains the design; it doesn't decide it. The rules and decisions live in [`architecture.md`](architecture.md#environments-and-network-secrets) and [`infra-decisions.md` §9](infra-decisions.md#9-how-network-secrets-reach-the-outside). If this guide and those disagree, they win, and this guide should be fixed.

## The short version

- The sandbox never gets your real key. It gets a fake one, called a **placeholder**, in the env var, for example `OPENAI_API_KEY=cloudswe_ph_OPENAI_API_KEY_3f9a…`.
- A small program inside the sandbox, the **egress daemon**, pretends to be `api.openai.com`. When code in the sandbox calls OpenAI, the call lands at the daemon instead.
- The daemon passes the call to our Cloudflare Worker. The Worker swaps the placeholder for the real key and calls the real OpenAI.
- The answer comes back the same way.

The code the agent runs doesn't change. `new OpenAI()` reads `OPENAI_API_KEY` and makes its call like always. It never knows the key was fake.

## Why it has to work this way

Two facts shape the whole design.

**1. The real key can't be in the sandbox.** The agent controls the sandbox. It can read any file, any env var, and the memory of any process there. If the key were anywhere in the sandbox, even for a moment, the agent could copy it. So the key has to stay outside, in the Worker, and be added only after the request has left the sandbox.

**2. You can't edit an HTTPS request on the way.** HTTPS is encrypted from the client all the way to the server. Something sitting in the middle sees scrambled bytes. It can't read the `Authorization` header, let alone change it. The only way to change a header is to _be_ the server the client thinks it's talking to: finish the encrypted handshake yourself, read the request in plain text, and then make a new request onward.

So we need something in the sandbox that can pretend to be `api.openai.com` well enough that clients believe it, but that knows no secrets. That's the egress daemon. The Worker does the part that needs the secret.

## A few terms first

You only need these to follow the rest.

| Term                           | What it means here                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DNS**                        | How a program turns a name like `api.openai.com` into an IP address it can connect to.                                                                                                                    |
| **`/etc/hosts`**               | A plain text file on Linux that maps names to IP addresses. Programs check it _before_ asking real DNS. If it says `127.0.0.1 api.openai.com`, the program connects to its own machine instead of OpenAI. |
| **`127.0.0.1`**                | "This machine." A connection to it never leaves the sandbox.                                                                                                                                              |
| **TLS**                        | The encryption under HTTPS. It starts with a **handshake**, where the server proves who it is with a certificate.                                                                                         |
| **Certificate**                | A small file that says "I am `api.openai.com`" and is signed by someone the client trusts.                                                                                                                |
| **CA (certificate authority)** | Someone whose signature clients trust. Every computer has a list of trusted CAs, called the **trust store**. A certificate signed by a CA on that list is believed.                                       |
| **SNI**                        | Part of the first handshake message where the client says which name it wants, for example "I want `api.openai.com`". It lets one server answer for many names.                                           |
| **Proxy**                      | A program that receives a request and sends it on somewhere else.                                                                                                                                         |
| **Durable Object**             | Cloudflare's small, long-lived storage objects. Our `Credentials` object holds environments and secrets; each session has its own `SessionThread` object.                                                 |

## The whole trip in one picture

```
 inside the sandbox (E2B VM)                     Cloudflare Worker                  the internet
 ┌────────────────────────────────────┐        ┌──────────────────────────┐       ┌───────────────┐
 │ curl https://api.openai.com/…      │        │ /net route               │       │ api.openai.com│
 │   │                                │        │                          │       │               │
 │   │ 1. /etc/hosts: api.openai.com  │        │ 4. is this token real?   │       │               │
 │   │    is 127.0.0.1                │        │ 5. which secrets allow   │       │               │
 │   ▼                                │        │    this host?            │       │               │
 │ egress daemon (root, port 443)     │        │ 6. placeholder → real key│       │               │
 │   2. shows a certificate for       │  HTTPS │ 7. call the real API ────────────►               │
 │      api.openai.com, signed by     │ ──────►│                          │ ◄─────│               │
 │      this sandbox's own CA         │        │ 8. hide the key in reply │       │               │
 │   3. reads the request, forwards   │ ◄──────│    headers, add trailer  │       │               │
 │   9. checks the trailer, replies   │        │                          │       │               │
 └────────────────────────────────────┘        └──────────────────────────┘       └───────────────┘
```

The rest of this guide walks through each step with the code that does it. The example is:

```bash
curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"
```

## Step 0: the placeholder

When you save a network secret (`PUT /v1/environments/:name/network-secrets/:key`), the Worker stores the real value in the `Credentials` Durable Object next to a placeholder it makes up:

```ts
// server/src/environments.ts, setNetworkSecret
const placeholder = existing?.placeholder ?? `cloudswe_ph_${name}_${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
```

The placeholder is made once and kept forever, even when you change the value. That way a program that's already running, holding the old placeholder, still works after you rotate the key.

The placeholder is a random string. On its own it's worth nothing: sent straight to OpenAI it just gets a 401.

**How it reaches the command.** Before each new command, the Worker works out what the sandbox should hold. `desired()` in `server/src/sandbox/egress.ts` asks `Credentials.sandboxView()`, which returns:

- each normal variable's real value,
- each network secret's **placeholder** (never its value),
- the list of hosts that have a network secret.

That goes into a file in the sandbox, `.cloud-swe/env.json`. The command supervisor reads that file right before it starts the command and adds its contents to the command's environment (`server/src/sandbox/runner.ts`). So the command sees:

```
OPENAI_API_KEY=cloudswe_ph_OPENAI_API_KEY_3f9a…
```

## Step 1: setting up the sandbox (once)

The first time a session with network secrets runs a command, the Worker installs the daemon. `apply()` in `server/src/sandbox/egress.ts` writes two files into the sandbox as root (the daemon and a setup script) and runs the script. The script is `SETUP_SCRIPT` in `server/src/sandbox/egress-daemon.ts`. It does four things.

**It makes a CA just for this sandbox.** It runs `openssl` to create `ca.key` (the private signing key) and `ca.crt` (the public certificate) in `/etc/cloud-swe`, which only root can read. Every sandbox gets its own CA, so one sandbox's CA means nothing in another.

**It adds that CA to the system trust store.** It copies `ca.crt` into `/usr/local/share/ca-certificates/` and runs `update-ca-certificates`. After this, curl, OpenSSL and anything else that uses the system's list will believe certificates this CA signs.

**It covers the programs that don't use the system list.** Some runtimes bring their own list of trusted CAs and ignore the system one. A few env vars fix that (`TRUST_ENV` in the same file):

| Env var               | Who reads it                | What we point it at                          |
| --------------------- | --------------------------- | -------------------------------------------- |
| `NODE_EXTRA_CA_CERTS` | Node.js                     | our CA, added on top of Node's built-in list |
| `REQUESTS_CA_BUNDLE`  | Python `requests`           | the system list, which now includes our CA   |
| `SSL_CERT_FILE`       | Python's `ssl`, many others | the system list                              |
| `HTTPLIB2_CA_CERTS`   | Python `httplib2`           | the system list                              |
| `DENO_CERT`           | Deno                        | our CA                                       |

The Python ones point at the whole system list, not just our CA. If they pointed at our CA alone, every other HTTPS site would stop working for Python.

**It starts the daemon and keeps it running.** The daemon runs inside a loop: `while :; do node egress.mjs; sleep 1; done`. If it ever crashes, it's back a second later.

**Updates.** `SETUP_VERSION` is a hash of the daemon's code and the setup script. If a later deploy changes either one, the version changes, and the next command in that sandbox runs the setup again.

## Step 2: sending the call to the daemon (`/etc/hosts`)

curl needs an IP address for `api.openai.com`. Linux checks `/etc/hosts` first. The daemon keeps one marked block in that file (`writeHosts()` in `server/src/sandbox/egress-daemon.ts`):

```
# BEGIN cloud-swe network secrets
127.0.0.1 api.openai.com
::1 api.openai.com
# END cloud-swe network secrets
```

So curl connects to `127.0.0.1` on port 443, which is the daemon, instead of to OpenAI.

Only hosts that have a network secret are listed. npm, pip, GitHub and every other site still go straight to the internet, untouched. We chose this over a firewall rule that would catch _all_ HTTPS traffic for exactly that reason: if the daemon breaks, only calls to secret hosts break. Your installs and Git pushes keep working.

## Step 3: the handshake (how the daemon passes as OpenAI)

curl starts the TLS handshake and says, through SNI, "I want `api.openai.com`". The daemon's TLS server handles that in its `SNICallback`, which calls `contextFor(host)`:

1. If the host isn't one the daemon was told about, it refuses the handshake.
2. Otherwise it uses `openssl` to make a certificate for `api.openai.com`, signed by the sandbox's CA, valid for 30 days. It keeps it in memory so it only does this once per host.

curl checks the certificate. The name matches, and it's signed by a CA in the trust store, the one we added in step 1. So curl accepts it, and the encrypted connection is set up between curl and the daemon.

Now the daemon can read the request in plain text, including the header `Authorization: Bearer cloudswe_ph_…`.

This trick only works inside this one sandbox, because only programs there trust its CA. The certificate is useless anywhere else.

The daemon only offers HTTP/1.1 (ALPN `http/1.1`), not HTTP/2. That keeps it simple: Node's plain `http` module handles the decrypted traffic.

## Step 4: the daemon forwards the call to the Worker

`handle()` in the daemon turns the request into a call to the Worker. The URL has the session and the original host in it:

```
https://cloud-swe-server.sudoanmol.workers.dev/net/<sessionId>/api.openai.com/v1/models
```

It copies the request's headers as they are. **The placeholder is still in there; the daemon never changes it.** It adds three headers of its own:

- `x-cloud-swe-network-token`: a random 64-character token. It proves to the Worker that the call really comes from this sandbox (more in step 5).
- `x-cloud-swe-nonce`: 16 random bytes, new for every single request. It's used at the end to check the reply wasn't cut off (step 8).
- `accept-encoding: identity`: asks for an uncompressed reply, so the daemon can read the last bytes of it.

The call to the Worker is normal, real HTTPS with Cloudflare's real certificate. The Worker's address isn't in `/etc/hosts`, so normal DNS is used.

**What the daemon knows.** Everything it knows is in one file, `/etc/cloud-swe/egress.json`: the Worker's URL, the session ID, the network token, and the list of hosts. No secret value. You could print that file and leak nothing that gives anyone the key.

## Step 5: the Worker checks who's calling

The `/net` route is on the public internet. Anyone could send it requests, so the first job is to turn away everyone except this sandbox. The route is `networkProxyRoutes()` in `server/src/sandbox/network-proxy.ts`. It's mounted in `server/src/index.ts` before sign-in, because the daemon isn't a signed-in user; the token is how it proves itself.

It checks, in order:

1. **The path is well formed.** `/net/<session id>/<host>/<path>`, with a real hostname. If not: 404.
2. **There's a nonce.** If not: 400.
3. **The token is right.** `networkAuthorization()` in `server/src/sandbox/egress.ts` runs in that session's `SessionThread` object:
   - It compares the token in **constant time**, meaning the check takes the same time whether the first character is wrong or the last one is. Otherwise an attacker could guess the token one character at a time by timing the answers.
   - The token must belong to the session's **current** sandbox. If the sandbox was replaced, the old token stops working.
   - The sandbox must not be deleted.
   - It never wakes up a paused sandbox just to check.

   If the token is wrong: 401. If the check itself fails (for example, storage is unreachable): 503, so it fails closed instead of letting the call through.

4. **This host is allowed.** `Credentials.networkSwaps(environment, host)` (in `server/src/environments.ts`) returns only the secrets whose list of allowed hosts includes this exact host. If none do: 403.

## Step 6: the swap itself

This is the step everything else exists for. `upstreamHeaders()` in `server/src/sandbox/network-proxy.ts` builds the headers for the real request:

- It drops headers that shouldn't go upstream: connection-level ones, Cloudflare's own `cf-*` and `x-forwarded-*` headers, and our two `x-cloud-swe-*` headers. OpenAI never sees the network token or the nonce.
- **In the one header the secret names**, `Authorization` by default, it replaces the placeholder with the real value. That's `swapped()`:

```ts
// server/src/sandbox/network-proxy.ts, swapped (simplified)
return value.replaceAll(swap.placeholder, swap.value);
```

`Basic` authentication is the one special case. There, the username and password are base64-encoded, so the placeholder is hidden inside the encoded text. `swapped()` decodes it, swaps, and encodes it again.

Nothing else is touched. The URL's query string and the request body go through as they are, so a placeholder there stays a placeholder.

Then the Worker makes the real call:

```ts
fetch(`https://api.openai.com/v1/models`, { method, headers, body, redirect: 'manual' });
```

`redirect: 'manual'` is important. If the server answered "302, go to `evil.com` instead", following it would send the request, with the real key in it, to `evil.com`. So any redirect is refused and the sandbox gets a 502. WebSocket connections follow the same rule.

The Worker never retries a call. The first try may already have done something on the other side, like creating a resource, so trying again could do it twice.

## Step 7: the reply comes back

Before passing the reply back, the Worker cleans it:

- **Headers:** `replyHeaders()` replaces any copy of the real key with `[redacted]`, in case the API echoes your key back in a header.
- **Body:** it goes through as a stream, so long or streaming replies (like the token-by-token answers from a chat model) flow through as they arrive. At the end, the Worker adds a short **trailer**. That's the next step.

## Step 8: the trailer (catching cut-off replies)

There's a nasty problem with streaming through a Worker. If OpenAI's connection dies halfway through a reply, the Worker's runtime can still end _its_ reply to the daemon normally. The daemon, and then curl, would get half a JSON document and think it was the whole thing. A program would then act on broken data without knowing it.

To catch that, `withTrailer()` in `server/src/sandbox/network-proxy.ts` adds 17 bytes after the body:

- the 16-byte nonce the daemon sent with this request, and
- one status byte: `0` if the body arrived in full, `1` if it broke.

The daemon always holds back the last 17 bytes it receives. When the stream ends, it checks them (the `reply.on('end', …)` handler in `handle()`):

- If they're exactly its own nonce followed by `0`, the reply was complete, and it ends the reply to curl normally.
- Anything else (wrong nonce, a `1`, or too few bytes) means the reply was cut off. The daemon breaks the connection to curl with `response.destroy()`, so curl sees a network error. That's the honest outcome.

Why a nonce and not just a fixed marker? A fixed marker could appear in a reply by accident, or on purpose. The nonce is random for each request and never leaves the daemon-to-Worker path, so the reply body can't fake it.

Holding back 17 bytes doesn't slow streaming down in any way you'd notice. Everything else passes straight through, just 17 bytes behind.

## Keeping the sandbox up to date

Environments change. You add a secret, remove one, or change a host list. The sandbox has to follow along, and it does so right before each new command (`syncSandbox()` in `server/src/sandbox/egress.ts`):

1. `desired()` works out what the sandbox should hold: the env file's contents and the daemon's config.
2. It hashes all of that. If the hash is the same as last time, nothing changed, and it makes no calls to the sandbox at all.
3. If it changed, `apply()` writes the new files as `.next` files through E2B's files API, then runs one short command that moves them into place. The command text only has file paths and a hash in it, never a value. (E2B logs command text, but not file contents written through its files API.)
4. The daemon checks its config file every 250 milliseconds. When it sees the new one, it rewrites `/etc/hosts`, forgets certificates for hosts that were removed, and writes the config's hash to `/run/cloud-swe/applied`.
5. `apply()` waits up to 5 seconds for that hash to show up. Once it does, the change is live, and the command starts.

If any of this fails, the command still runs, and the agent gets a warning (`environment_stale`) that it may see older values. The next command tries again.

A command that's already running keeps the values it started with. Changes only reach commands started after them.

## WebSockets

WebSocket connections take the same path. The daemon forwards the upgrade request to `/net`, the Worker swaps the header and connects to the real host, and then both sides just pass messages back and forth. The Worker passes back the subprotocol the server picked (the `Sec-WebSocket-Protocol` header, with the key hidden if it appears there), because many clients refuse the connection without it. There's no trailer for WebSockets; they have their own way of signaling a clean close.

## Why this is safe, even though the agent can't be trusted

Here's everything the agent could get its hands on inside the sandbox, and what it could do with each:

| What the agent can read                                       | What it can do with it                                                                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The placeholder                                               | Nothing. Sent anywhere directly, it's a random string.                                                                                                                            |
| The network token in `egress.json` (the agent can use `sudo`) | Send calls through the proxy as this sandbox, but only to the hosts you allowed. It never gets the key back, and the token stops working when the sandbox is replaced or deleted. |
| The sandbox's CA key                                          | Fool programs inside its own sandbox, which it already controls anyway.                                                                                                           |
| The daemon's memory                                           | Nothing useful. The daemon never sees the real value.                                                                                                                             |

The one thing this design can't stop, and no design like it can: the agent can still _use_ the key through the proxy, on the hosts you allowed. For example, it can call OpenAI and spend your credits. It can never read the key or copy it out. And if an allowed host echoes request headers back in its body, the key comes back with it, so only allow hosts you trust.

## What doesn't work, and why

Each of these follows from how the swap works:

- **Programs that skip `/etc/hosts`.** Some use DNS over HTTPS, some connect to a hard-coded IP, and Docker containers have their own `/etc/hosts`. They go straight to the real host with the placeholder and get a 401.
- **Programs with their own fixed list of trusted CAs.** They refuse the daemon's certificate.
- **Keys in the URL or the body.** Only the named header is swapped.
- **Signed requests,** like AWS SigV4. The client signs the request with the placeholder in it. When the Worker changes the header, the signature no longer matches.
- **HTTP/2-only clients and gRPC.** The daemon only speaks HTTP/1.1.
- **Waiting more than about 125 seconds for the first byte.** Cloudflare ends the request with a 524. Once data starts flowing, there's no limit.

The full list is in [`infra-decisions.md` §9](infra-decisions.md#9-how-network-secrets-reach-the-outside).

## Questions people ask

**Why not just set `HTTPS_PROXY`?** Many programs ignore it. And even with it, an HTTPS proxy only sees encrypted bytes unless it does the same certificate trick. You'd still need everything above, and fewer programs would use it.

**Why not swap the key inside the sandbox? It would be simpler.** Then the key would be in the sandbox, which is the one thing we can't allow. Anything the daemon could read, the agent could read too.

**Why does the daemon need a token at all?** The `/net` route is public. Without the token, anyone on the internet who learned a session ID could make calls with your keys.

**Why run the daemon as root?** It has to listen on port 443 and edit `/etc/hosts`, which only root can do. It holds nothing secret, so running as root doesn't put the key at risk.

**What happens if the daemon crashes?** The loop restarts it a second later. In that second, calls to secret hosts fail. Nothing else is affected, because nothing else goes through it.

## Where to read the code

In the order a request travels:

1. [`server/src/environments.ts`](../server/src/environments.ts): `setNetworkSecret` (makes the placeholder), `sandboxView` (what the sandbox may hold), `networkSwaps` (which secrets apply to a host).
2. [`server/src/sandbox/egress.ts`](../server/src/sandbox/egress.ts): `desired` and `apply` (put the env file and daemon config into the sandbox), `syncSandbox`, `networkAuthorization`.
3. [`server/src/sandbox/egress-daemon.ts`](../server/src/sandbox/egress-daemon.ts): `SETUP_SCRIPT` (the CA and trust store), then the daemon itself: `writeHosts`, `contextFor`, `handle`, and the trailer check.
4. [`server/src/sandbox/network-proxy.ts`](../server/src/sandbox/network-proxy.ts): the `/net` route, top to bottom.

To watch it work:

- [`server/test/egress.test.ts`](../server/test/egress.test.ts) runs the real daemon in a Docker container against a fake API. It's the best file to step through.
- [`server/test/network-proxy.test.ts`](../server/test/network-proxy.test.ts) covers the `/net` route: the token checks, the swap, redirects, redacted headers, the trailer and WebSockets.
- The `network-secrets` stage in [`experiments/e2b-e2e/run.mjs`](../experiments/e2b-e2e/run.mjs) runs the whole thing on a real E2B sandbox with curl, Node, Python and the OpenAI SDK. It costs money, so run it only when you need to.
