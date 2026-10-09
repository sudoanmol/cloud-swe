# Git broker proxy

The sandbox and runner reach the GitHub broker through `GIT_BROKER_URL`. A Modal sandbox runs outside your machine, so in local development that URL has to be public. Expose only the broker routes; the rest of the API, auth, the web app, PostgreSQL and Temporal stay private.

The current local setup puts Caddy behind Tailscale Funnel:

```text
sandbox / runner
  → https://<machine>.<tailnet>.ts.net:8443   Tailscale Funnel (public HTTPS)
  → http://127.0.0.1:3774                     Caddy: forwards the allowlist, 404s the rest
  → http://127.0.0.1:3000                     API server (Fastify)
```

The [Cloudflare tunnel runbook](cloudflare-git-broker-tunnel.md) does the same job with a named tunnel and its own ingress rules.

## Routes to expose

| Path                                                                    | Caller                    | Authentication              |
| ----------------------------------------------------------------------- | ------------------------- | --------------------------- |
| `/git/read/info/refs`, `/git/read/git-upload-pack`                      | Sandbox Git (clone/fetch) | Short-lived read capability |
| `/git/upload`                                                           | Sandbox curl (bundles)    | Single-use upload token     |
| `/internal/git/access`, `upload`, `prepare`, `check`, `execute`, `read` | Runner                    | `GIT_BROKER_SECRET`         |

The runner calls the internal routes through the same `GIT_BROKER_URL`. When you add a broker route, add it to the proxy allowlist too. A missing route gets an empty `404`; the runner cannot read an error code from it and reports `GIT_UPSTREAM_FAILED`, shown as "GitHub could not complete the request."

## Set it up on macOS

1. Install Caddy and Tailscale, sign in to Tailscale, and enable Funnel for the machine in the tailnet's access controls.

   ```sh
   brew install caddy
   ```

2. Save the allowlist as `~/.config/cloud-swe/git-broker.Caddyfile`:

   ```caddyfile
   {
   	admin off
   }

   :3774 {
   	bind 127.0.0.1
   	@broker path /git/read/info/refs /git/read/git-upload-pack /git/upload /internal/git/access /internal/git/upload /internal/git/prepare /internal/git/check /internal/git/execute /internal/git/read
   	handle @broker {
   		reverse_proxy http://127.0.0.1:3000
   	}
   	handle {
   		respond 404
   	}
   }
   ```

   Check it with `caddy validate --config ~/.config/cloud-swe/git-broker.Caddyfile`.

3. Keep Caddy running with a launch agent at `~/Library/LaunchAgents/dev.cloud-swe.git-broker-proxy.plist`. Replace `<you>` with your user name:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
   	<key>Label</key>
   	<string>dev.cloud-swe.git-broker-proxy</string>
   	<key>ProgramArguments</key>
   	<array>
   		<string>/opt/homebrew/bin/caddy</string>
   		<string>run</string>
   		<string>--config</string>
   		<string>/Users/<you>/.config/cloud-swe/git-broker.Caddyfile</string>
   	</array>
   	<key>RunAtLoad</key>
   	<true/>
   	<key>KeepAlive</key>
   	<true/>
   	<key>StandardOutPath</key>
   	<string>/Users/<you>/Library/Logs/cloud-swe-git-broker-proxy.out.log</string>
   	<key>StandardErrorPath</key>
   	<string>/Users/<you>/Library/Logs/cloud-swe-git-broker-proxy.err.log</string>
   </dict>
   </plist>
   ```

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.cloud-swe.git-broker-proxy.plist
   ```

4. Publish Caddy's port with Funnel. It persists across restarts:

   ```sh
   tailscale funnel --bg --https=8443 http://127.0.0.1:3774
   tailscale funnel status
   ```

5. In `.env`, set `GIT_BROKER_URL=https://<machine>.<tailnet>.ts.net:8443` with no path, plus `GIT_BROKER_SECRET` and `GIT_BROKER_STORAGE` as described in [GitHub broker configuration](github-broker.md#configuration). Restart the server and runner.

## Verify

```sh
# A broker route reaches the API: an unauthenticated call is refused with a JSON error.
curl -s -X POST "$GIT_BROKER_URL/internal/git/access" -w ' %{http_code}\n'
# Anything else stops at Caddy with an empty 404.
curl -s "$GIT_BROKER_URL/api/auth/get-session" -w ' %{http_code}\n'
```

A broker route that returns an empty `404` is missing from the Caddyfile.

## Change or stop it

- **Edit the allowlist:** `admin off` disables `caddy reload`, so validate, then restart the agent with `launchctl kickstart -k gui/$(id -u)/dev.cloud-swe.git-broker-proxy`.
- **Logs:** `~/Library/Logs/cloud-swe-git-broker-proxy.*.log`.
- **Stop exposure:** `tailscale funnel --https=8443 off`. To remove Caddy, run `launchctl bootout gui/$(id -u)/dev.cloud-swe.git-broker-proxy`.
