# Named Cloudflare tunnel for Git transport

This is a runbook, not a provisioned tunnel. Obtain separate approval before creating Cloudflare resources or changing the actual `.env`. No account, hostname or tunnel credentials belong in Git.

## Prerequisites

- An owned hostname in a Cloudflare-managed zone and an agreed tunnel name.
- `cloudflared` installed and authenticated to the intended account.
- Fastify listening on `http://localhost:3000`, with Git broker configuration, persistent bundle storage and required GitHub App permissions.
- The same `GIT_BROKER_SECRET` on server and runner. Never replace an existing secret just to configure a tunnel.

Inspect `cloudflared tunnel list` and existing local configuration first. Reuse the intended tunnel if present. Do not overwrite unrelated ingress rules or credentials. If authentication is needed, run `cloudflared tunnel login` interactively in the approved account.

## Create and route the tunnel

Run only after choosing the actual name and hostname:

```sh
cloudflared tunnel create <name>
cloudflared tunnel route dns <name> <hostname>
```

Record the returned tunnel UUID. Store the credentials JSON outside the repository, restrict it to its owner, and reference its absolute path from a local configuration file such as `~/.cloudflared/cloud-swe-git.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /absolute/private/path/<tunnel-uuid>.json

ingress:
  - hostname: <hostname>
    path: ^/git/read/(info/refs|git-upload-pack)$
    service: http://localhost:3000
  - hostname: <hostname>
    path: ^/git/upload$
    service: http://localhost:3000
  # The runner currently uses GIT_BROKER_URL for these authenticated calls too.
  # These endpoints require the server/runner secret, never a guest capability.
  - hostname: <hostname>
    path: ^/internal/git/(access|upload|prepare|check|execute|read)$
    service: http://localhost:3000
  - service: http_status:404
```

Expose only these required broker paths. Do not forward all `/api/*`, auth routes, the web app, PostgreSQL, Temporal or desktop/control endpoints. The runner uses the same broker URL for internal calls, so omitting those narrowly listed paths would break broker operation. Backend signatures, ownership checks and write approvals remain mandatory.

Validate the local ingress before running it:

```sh
cloudflared tunnel --config ~/.cloudflared/cloud-swe-git.yml ingress validate
cloudflared tunnel --config ~/.cloudflared/cloud-swe-git.yml ingress rule https://<hostname>/git/read/info/refs
cloudflared tunnel --config ~/.cloudflared/cloud-swe-git.yml ingress rule https://<hostname>/api/auth/get-session
cloudflared tunnel --config ~/.cloudflared/cloud-swe-git.yml run <name>
```

The auth URL must select the catch-all 404 rule. Keep the process supervised when deploying permanently; do not use a temporary Quick Tunnel as a durable broker origin.

## Configure the application after provisioning

Set `GIT_BROKER_URL=https://<hostname>` on the server and runner. Preserve `GIT_BROKER_SECRET`, `GIT_BROKER_STORAGE`, transfer limits and free-space settings. Restart only the intended application processes using the normal deployment procedure.

Do not change `VITE_API_URL`, `BETTER_AUTH_URL`, GitHub OAuth callbacks or `CORS_ORIGIN` merely because the broker has a public hostname. The tunnel is not the browser API origin by default. Do not put an interactive Cloudflare Access login page in front of guest capability endpoints; Git clients cannot complete it.

## Verify before enabling repository work

1. Unauthenticated `/git/read/info/refs?service=git-upload-pack`, `/git/upload` and `/internal/git/access` requests must fail. Unlisted paths must return 404.
2. Through an approved local runner test, obtain a short-lived read capability for an owned run/generation and verify ref discovery and upload-pack. Expired, wrong-generation and foreign capabilities must fail. A read capability cannot upload, approve or execute writes.
3. Verify query strings and authorization tokens are absent from backend, proxy and tunnel logs. Avoid shell commands that place secrets in history; use the existing broker test/client mechanisms.
4. Test transfer size and duration against the actual Cloudflare account limits, application bounds and available disk space. The application's default 4 GiB staging allowance does not imply that Cloudflare accepts a 4 GiB request. Do not loosen application security checks to bypass an upstream limit.
5. Confirm browser sign-in, onboarding and ordinary API requests still use their intended origin and cookies.

Live Git writes and paid VM/model tests need separate authorization. Local ingress validation does not certify live Cloudflare, GitHub or Modal behavior.

## Stop or roll back

Stop the tunnel process to remove exposure. Keep credentials and DNS unless deletion is explicitly approved. To disable broker transport, remove all three transport settings together in the intended deployment configuration; leaving only a secret or storage path intentionally fails startup. GitHub onboarding and metadata reads can remain enabled without transport.
