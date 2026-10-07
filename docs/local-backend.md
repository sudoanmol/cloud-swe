# Run the backend locally

The backend accepts prompts, runs agents in isolated workspaces, and streams durable events. The TanStack Start UI uses Fastify REST/SSE and Better Auth cookies. The repository-free scripted API path needs no model or Modal credentials; the product UI requires GitHub onboarding, a connected model provider and a repository.

Use Docker, Node.js 24, and Bun 1.4.

## Start PostgreSQL and Temporal

```sh
bun install
bun run infra:up
```

Compose starts PostgreSQL on `127.0.0.1:5432`, Temporal on `127.0.0.1:7233`, and the Temporal UI at <http://localhost:8233>. Both services store their data in Docker volumes. The pinned Temporal image runs its development server with a persistent SQLite database.

If you do not have the root environment file, create it from the example:

```sh
test -e .env || cp .env.example .env
```

If that file already exists, merge the example settings into it. Set `DATABASE_URL` to `postgresql://postgres:password@localhost:5432/cloud-swe`. The server, runner and database tools load this root file; the web app reads its `VITE_` variables from it through Vite. The loader runs once per process, preserving explicit environment overrides. The web build only requires `VITE_API_URL`, not database/model credentials or migrations.

Apply the migrations:

```sh
bun run db:migrate
```

These migrations include the original authentication tables and target a fresh database. An existing database created with `db:push` needs a migration baseline before applying the initial migration. Do not delete existing data to work around a migration error.

## Start the application processes

With the local Cloudflare tunnel configured, `bun dev` starts the web app, server, worker, dispatcher, gateway, and tunnel together. The tunnel requires `cloudflared` and `~/.cloudflared/cloud-swe-previews-dev.yml`. Stop them together with Ctrl+C. PostgreSQL and Temporal must already be running through `bun run infra:up`.

To start the application processes without the tunnel, use `bunx turbo run dev dispatcher`. To run only the tunnel, use `bun run dev:tunnel`.

Run each command from the repository root in a separate terminal:

```sh
bun run dev:server
```

```sh
bun run dev:runner
```

```sh
bun run dev:dispatcher
```

```sh
bun run dev:web
```

All four processes reload on save: Vite and the Bun server hot-reload, and the worker and dispatcher restart under `tsx watch`, including for edits in workspace packages. A worker restart interrupts its in-flight activities; Temporal retries them and the run resumes from its last checkpoint, so expect an edit during a run to exercise recovery. The web UI is at <http://localhost:3001>. Use that host, not `127.0.0.1`, because CORS and cookies are bound to `CORS_ORIGIN`. `bun run dev` also starts the gateway, which requires previews or hosted browsers to be configured. Use the individual commands when those features are disabled. Set `VITE_API_URL=http://localhost:3000`, `BETTER_AUTH_URL=http://localhost:3000` and `CORS_ORIGIN=http://localhost:3001`. Keep the same `localhost` spelling for browser/API hosts so cookies are accepted. The browser calls Fastify directly with credentials; do not add a web-server auth proxy.

The API accepts requests and serves PostgreSQL state. The dispatcher delivers pending outbox commands to Temporal. The separate `apps/runner` worker processes workflows and activities under Node.js. Its Docker access stays on the host, outside workspace containers.

The first local workspace pulls a pinned Ubuntu 24.04 image. Each container has a CPU, memory, and process limit. Containers have no network, host mounts, Docker socket, or upstream credentials. The local Docker path cannot clone a repository.

Public repository cloning uses the Pi and Modal path. Set `RUNNER_EXECUTION_MODE=pi`, `RUNNER_SANDBOX_PROVIDER=modal`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `MODAL_ENVIRONMENT`, and `MODEL_CREDENTIALS_ENCRYPTION_KEY` before starting the server and runner. Generate the encryption key with `openssl rand -hex 32` and use the same value in both processes. Complete the GitHub installation and provider steps at `/onboarding`, then include `modelSelection` on each Pi submission. Provider setup also remains available through the [model broker endpoints](backend-contract.md#model-broker). Copy the token from `~/.modal.toml` after `modal token new`. Sandboxes start from the image published by `uv run infra/modal/build_image.py`; see `infra/modal/MANIFEST.md`.

Set `BRAVE_SEARCH_API_KEY` to enable Pi web search. Set `FIRECRAWL_API_KEY` to enable web fetch, Firecrawl search fallback, and search-result extraction. Either key enables `web_search`; only Firecrawl enables `web_fetch`. These keys are backend-only and must not be placed in the sandbox.

To enable attachments, create a private Cloudflare R2 bucket and set these variables in the root `.env` file:

```sh
R2_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=cloud-swe-attachments
R2_REGION=auto
```

Use credentials that can read, write, and delete objects in only this bucket. Set the same values for the API server and the runner. Do not expose them to the browser or a workspace. If `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` are all unset, the backend keeps text-only submissions available.

For private repositories and approved GitHub writes, also [enable the GitHub broker](#enable-the-github-broker). The isolated Docker sandbox remains unable to access the broker or clone repositories.

## Workspace timers

A completed run with no queued messages starts a ten-minute idle grace period.
The worker then pauses the workspace, which stays paused while Modal keeps the
exit snapshot, 30 days after each pause. Reading the review panel postpones the pause, and submitting a follow-up starts a restore. Closing a browser does not start these timers while
an agent is still working. Background dev servers do not count as agent work.

A follow-up resumes the same files, but not processes. A follow-up after the
snapshot expired creates a new workspace, clones the repository again,
and restores the conversation with a reset instruction. Local unpushed work
is lost then.

Sandboxes live at most `MODAL_MAX_RUN_SECONDS=5400`, or ninety minutes. Modal enforces this as a hard timeout even when the runner is down, and the exit snapshot keeps the files. Idle pause normally stops the sandbox after `RUNNER_IDLE_PAUSE_MS`. A restored sandbox keeps files but not processes. To list anything still running, use `modal app list` and check the task count for `cloud-swe-workspaces`.

## Submit a prompt and watch events

Create a local account and save the session cookie:

```sh
curl -sS -c /tmp/cloud-swe.cookies \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3001' \
  -d '{"name":"Local demo","email":"demo@example.com","password":"local-demo-password-123"}' \
  http://localhost:3000/api/auth/sign-up/email
```

If the account already exists, use `/api/auth/sign-in/email` with its email and password.

Thread mutations require the trusted `Origin` and `X-CSRF-Protection: 1` headers. JSON submissions also require `Content-Type: application/json`. Local development allows an unverified email account unless `ALLOW_UNVERIFIED_COMPUTE=false`. Production compute requires a linked GitHub account created through the configured GitHub App. New Pi compute additionally requires completed onboarding. Local email/password auth remains available for deterministic API tests, not as a product sign-in screen.

Use a GitHub App, not a legacy OAuth App. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from the App's user authorization Client ID and client secret. Callback URL: `{BETTER_AUTH_URL}/api/auth/callback/github` (local example: `http://localhost:3000/api/auth/callback/github`). Grant **Account permissions → Email addresses → Read-only**. Better Auth still calls `GET /user/emails` after the token exchange. Do not configure OAuth scopes; GitHub App user tokens use App permissions and return an empty `scope`. Set the server-only `GITHUB_APP_SLUG` to the App's URL slug. The root landing offers GitHub sign-in; successful sign-in returns to `/`, which routes incomplete users to `/onboarding`. Grant the App at least one repository, then connect ChatGPT device login, AI Gateway, OpenRouter or DeepSeek. Existing installations and saved credentials prefill these steps. Installation query parameters alone never prove access. The Git broker uses these user tokens server-side; see [GitHub broker configuration](github-broker.md).

Submit a prompt:

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'X-CSRF-Protection: 1' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Check the workspace","clientMessageId":"local-demo-1"}' \
  http://localhost:3000/api/threads
```

To submit a file, upload it first. Save the returned attachment ID, then include it in the prompt request:

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'X-CSRF-Protection: 1' \
  -F 'file=@/absolute/path/to/image.png' \
  http://localhost:3000/api/attachments
```

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'X-CSRF-Protection: 1' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Inspect this image","clientMessageId":"attachment-demo-1","attachmentIds":["ATTACHMENT_ID"],"modelSelection":{"provider":"openai-codex","model":"gpt-5.4","thinkingLevel":"medium"}}' \
  http://localhost:3000/api/threads
```

Upload all selected files before prompt submission. Preserve the selection order in `attachmentIds`. An image-only request can use an empty `prompt`.

To start a Modal Pi run from a GitHub branch, add `repositoryUrl`, `branch`, and `modelSelection` to the initial request. First complete onboarding, connect the provider and choose a model and thinking level from its [catalog endpoint](backend-contract.md#model-broker). This example uses ChatGPT device OAuth. Replace the repository and branch with values you can access. The follow-up endpoint does not accept repository or branch fields.

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'X-CSRF-Protection: 1' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Inspect the project","clientMessageId":"modal-demo-1","repositoryUrl":"https://github.com/owner/repository","branch":"main","modelSelection":{"provider":"openai-codex","model":"gpt-5.4","thinkingLevel":"medium"}}' \
  http://localhost:3000/api/threads
```

The API returns `202` with `threadId` and `runId`. Replace `THREAD_ID` below with the returned ID:

```sh
curl -N -b /tmp/cloud-swe.cookies \
  'http://localhost:3000/api/threads/THREAD_ID/events?after=0'
```

You will see queued, workspace, tool, assistant, and completion events. The scripted agent writes the prompt as data and creates `/workspace/runs/RUN_ID/result.txt`. It does not interpret your prompt as code or call a model.

Press Ctrl-C to disconnect. Execution continues. Reconnect with the last event ID you consumed:

```sh
curl -N -b /tmp/cloud-swe.cookies \
  -H 'Last-Event-ID: LAST_EVENT_ID' \
  http://localhost:3000/api/threads/THREAD_ID/events
```

Read the thread snapshot:

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  http://localhost:3000/api/threads/THREAD_ID
```

Submit another message to the same thread:

The example below uses scripted mode. In Pi mode, include `modelSelection` on every follow-up, even when reusing the previous model.

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'X-CSRF-Protection: 1' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Run the check again","clientMessageId":"local-demo-2"}' \
  http://localhost:3000/api/threads/THREAD_ID/messages
```

Cancel a run:

```sh
curl -sS -X POST -b /tmp/cloud-swe.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'X-CSRF-Protection: 1' \
  http://localhost:3000/api/threads/THREAD_ID/runs/RUN_ID/cancel
```

Cancellation returns `202`. Wait for `run.cancelled` or inspect the run state to observe completion of cancellation. A dispatched guest command must settle or be reconciled before another mutating command can start. An unknown outcome keeps exclusive ownership of its workspace generation and blocks further commands instead of permitting an unsafe retry; a later run reconciles it again before doing anything else.

When Pi asks a question, list the durable requests:

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  http://localhost:3000/api/threads/THREAD_ID/questions
```

Answer every question in one request. Replace `REQUEST_ID` and the answer keys with values from the stored request:

```sh
curl -sS -X POST -b /tmp/cloud-swe.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'X-CSRF-Protection: 1' \
  -H 'Content-Type: application/json' \
  -d '{"answers":{"deploy_target":"Staging"}}' \
  http://localhost:3000/api/threads/THREAD_ID/questions/REQUEST_ID/answer
```

The run remains active while waiting and resumes from its Pi checkpoint after the answer. There is no question timeout. Repeating the same answer is safe; a different answer returns `409`.

Deleting a workspace loses uncommitted files and local, unpushed commits. A later run gets a new filesystem generation and a reset instruction; only the conversation and checkpoints are durable outside the VM.

## Verify recovery

```sh
bun run test:db
bun run test:backend
bun run check-types
bunx oxlint
bunx oxfmt --check
```

The tests use disposable databases, real authentication, Temporal, and labeled Docker workspaces. The backend suite restarts PostgreSQL and Temporal to exercise recovery, including errors on borrowed PostgreSQL connections. Do not run it against services used by another process. A separate Compose project keeps a running development backend undisturbed:

```sh
export COMPOSE_PROJECT_NAME=cloud-swe-backend-check
export POSTGRES_PORT=55432 TEMPORAL_PORT=17233 TEMPORAL_UI_PORT=18233
bun run test:backend
# Remove only this test project's infrastructure after the suite exits.
docker compose down -v
```

Choose free ports and a new project name. The integration helper uses these Compose port overrides, creates its own database, and disables inherited Git transport and paid title credentials. Without overrides it uses the ordinary development ports, so stop other local backend processes first. See the [README validation commands](../README.md#validation) for the full local suite.

`bun test apps/runner/tests/remote-progress.test.ts` requires Docker and local PostgreSQL. It verifies a real guest output chunk is visible through a separate database connection while the command journal still reports `running`.

## Apply audit command scheduling

Migration `0010_audit_command_scheduling.sql` changes command admission and guest fencing together. Stop new submissions, drain or cancel runs, and reconcile outstanding commands before stopping the old API, dispatcher, and workers. Preserve ownership records for any unresolved operation.

Apply migrations with `bun run db:migrate`, then start all three updated backend processes. The database migration role needs permission to install PostgreSQL's `btree_gist` extension. The migration retains legacy operations as exclusive, adds read slots and a durable command queue, and removes unused `outbox.payload` data.

Do not mix old workers with the new schema and guest protocol. The `recovery-cancellation-scope-v1` and `finalizer-failure-code-v1` patches preserve tested pre-audit workflow histories. They do not establish compatibility with every older release; follow the upgrade procedure below when crossing those releases.

## Apply checkpoint ownership fencing

Stop old workers before applying migration `0008_checkpoint_ownership.sql`. New checkpoint writes and attempt-driven completion require a database-issued ownership token. There is no tokenless compatibility path for old workers. Historical checkpoints remain readable; resumed work obtains ownership before writing.

The Effect adoption preserves representative existing workflow histories. This does not establish compatibility with older releases that changed workflow commands. Follow the existing upgrade procedure below when crossing those releases.

## Apply attachment storage and checkpoint version 2

Stop old workers before the first deployment that can write Pi checkpoint version 2. Old workers cannot restore attachment image references. Drain or cancel active runs, stop the API server, the dispatcher, and all workers, then apply migration `0014_unusual_goblin_queen.sql`.

Set the R2 variables before you restart the API server and workers. Start only the updated processes. Existing Pi checkpoint version 1 data remains readable. Do not enable attachment uploads until every worker runs the updated code.

## Upgrade an existing backend

This schema migration and workflow change are not a rolling upgrade. Do not start the new worker against open histories produced by the old workflow implementation. Keeping an activity export with the same name does not establish replay compatibility.

Before upgrading, stop accepting new compute requests. Keep the old dispatcher and worker running until queued and active runs finish or complete cancellation. Resolve outstanding commands and pause the workspaces before stopping those processes. Close the remaining idle workflows using the old deployment, or terminate them only after confirming they have no active run or pending workspace operation. Preserve PostgreSQL data and Temporal history.

Stop the old API, dispatcher, and worker before applying migrations. Start the new deployment only after migration succeeds. New messages use the durable thread data and start new workflow executions. Verify that a follow-up message on an existing thread works before reopening admission.

If an operation cannot be reconciled, keep admission disabled for that workspace. Do not clear its ownership records or reset its generation merely to get the upgrade through. Deployments that cannot drain need workflow versioning and replay tests before using this release.

## Apply the web migration

Deploy additive migration `0015_wild_kid_colt.sql` before the updated server/runner, then deploy the frontend. It adds only `user.onboarding_completed` and `thread.title_generation_started_at`. Existing users start incomplete and can reuse installed repositories and saved providers. Existing titles and checkpoints are not rewritten. A rollback keeps the additive columns and durable events; do not drop them.

Optional application-owned titles use `DEEPSEEK_API_URL=https://api.deepseek.com` and server-only `DEEPSEEK_API_KEY`. They always use `deepseek-flash`, independently of the user's chat provider. Missing configuration or title failure leaves `New Thread` permanently, without affecting runs. Never expose this key through a `VITE_` variable.

Build the UI without running a database migration:

```sh
VITE_API_URL=http://localhost:3000 bun run --cwd apps/web build
```

GitHub metadata and onboarding do not need a public broker tunnel. When transport is disabled, leave all three `GIT_BROKER_URL`, `GIT_BROKER_SECRET` and `GIT_BROKER_STORAGE` unset. Partial configuration intentionally fails startup. Follow the [named tunnel runbook](cloudflare-git-broker-tunnel.md) only when separately provisioning private Git transport. The browser API origin and broker hostname are separate settings.

For production, use same-site HTTPS web/API hosts, exact trusted origins and secure HttpOnly cookies. The web server reads the session by forwarding the browser's cookies to the API, so the auth cookies must also reach the web host: either serve both from one host or scope Better Auth cookies to the shared parent domain. Verify cookie acceptance in the actual browser. Do not fix CORS with `*` or expose GitHub/model tokens to the frontend.

Git approval buttons, a file tree/right sidebar, desktop access and tunnel provisioning remain outside this migration.

## Stop the services

Stop the application processes with Ctrl-C. Then stop the infrastructure without deleting data:

```sh
bun run infra:stop
```

Inspect health and logs with `docker compose ps` and `bun run infra:logs`.

`docker compose down` removes service containers while preserving volumes. Adding `--volumes` deletes the local PostgreSQL and Temporal data.

The Compose ports bind to localhost. Temporal's development server is not a production deployment configuration.

## Restrict who can run tasks

Set `ALLOWED_GITHUB_ACCOUNT_IDS` to the comma-separated numeric GitHub account IDs that may run tasks, then restart the server. Never substitute a login name or email; `https://api.github.com/users/<login>` shows the numeric ID. An unset list admits no GitHub account. Set a Modal workspace budget on the Usage & Billing page to cap monthly spend.

Run local checks with `bun run test:db`, `bun run test:backend`, and `bun test apps/runner/tests/remote-tools.test.ts`. Backend integration builds `apps/runner/tests/Dockerfile`, an Ubuntu/Python test image. Runtime containers remain network-disabled. Browser verification uses isolated test API/UI processes and external-provider fixtures; it does not certify paid Modal or live OAuth.

## Enable the GitHub broker

Follow the [existing-backend upgrade procedure](#upgrade-an-existing-backend) before replacing a deployment. Apply migrations in order with `bun run db:migrate`: `0010_audit_command_scheduling`, `0011_model_broker`, then `0012_git_approvals`. Start the updated server, runner, and dispatcher only after migration succeeds.

Configure the GitHub App repository permissions and the broker's persistent directory. Set the same `GIT_BROKER_URL` and `GIT_BROKER_SECRET` on the server and runner, and set `GIT_BROKER_STORAGE` on the server. The URL must be an origin reachable from the workspace, with HTTPS outside localhost. Git must be installed on the server. See [GitHub broker configuration and API](github-broker.md) for permissions and storage limits.

This release does not preserve old workflow-history compatibility for the Git approval path. Finish or cancel existing runs before replacing the worker deployment. Approval decisions remain available through the authenticated API. The frontend shows the wait and Stop, but deliberately has no approve/reject controls.

## Enable Pi web and question tools

Apply migration `0013_questions.sql` before starting the updated API server, runner, or dispatcher. Do not mix updated processes with the old schema. The migration adds durable question requests and separate question-wait accounting; it does not modify Git approval records.

Set either optional web-provider key as described above, then start all three backend processes. No provider key is required for `ask_questions`. Existing Temporal histories remain replayable because the question branch is reached only from the new recorded activity result. Live Brave, Firecrawl, Modal, and model calls remain separately authorized paid checks.

## Enable previews and the hosted browser

Apply migration `0023_previews_browser` before starting the updated services. For previews, set `PREVIEW_DOMAIN=p.anmolhurkat.com` on the server, runner, and gateway. The gateway also needs `DATABASE_URL`, `MODAL_TOKEN_ID`, and `MODAL_TOKEN_SECRET`, plus `MODAL_ENVIRONMENT` when used. Leave `PREVIEW_DOMAIN` unset to disable previews.

To enable hosted browsers, set these three values together on the server, runner, and gateway:

```sh
KERNEL_API_KEY=<Kernel account key>
BROWSER_RELAY_URL=wss://<gateway-host>/cdp
BROWSER_RELAY_SECRET=<at least 32 random characters>
```

Use the same `RUNNER_IDLE_PAUSE_MS` across those processes. Browser-only gateways do not require Modal credentials. Neither feature exposes provider account keys to the guest or web frontend.

Run the gateway from the repository root:

```sh
bun run --cwd apps/gateway dev
```

The default address is `0.0.0.0:3002`. Set `GATEWAY_HOST` and `GATEWAY_PORT` to override it. A loopback relay URL may use `ws://`; a Modal guest needs a public `wss://` endpoint. Kernel cannot load preview servers through your computer's localhost.

For Railway:

1. Create a gateway service from this repository, using the repository root as its build context. Use `bun install --frozen-lockfile && bun run --cwd apps/gateway build` as the build command and `bun run --cwd apps/gateway start` as the start command.
2. Set the gateway environment values and set both `PORT` and `GATEWAY_PORT` to `3002`. Keep one gateway replica for activity debounce.
3. Add the custom domain `*.p.anmolhurkat.com` to that service, targeting port 3002. Add the DNS records Railway supplies for wildcard routing and certificate validation. In Cloudflare, set the `*.p` CNAME to **DNS only**.
4. Give the same service a public hostname for CDP, such as its Railway generated domain. Set `BROWSER_RELAY_URL` to `wss://<that-host>/cdp` in all three services.
5. Keep application authentication cookies host-only. Do not scope them to `.anmolhurkat.com`, which also contains untrusted previews. A separate registrable preview domain provides stronger site isolation and requires only a `PREVIEW_DOMAIN` change.

Build and publish the updated Modal image before enabling previews. See the manifest for the current verified image; publishing a new recipe requires a separately authorized paid build. Existing exit snapshots keep their old tools. Use a fresh workspace or explicitly migrate an old snapshot before expecting port 7999 to work.

Open the Browser tab to watch the agent, select a preview port, or take control. The panel polls every 30 seconds while open, and preview requests update review activity at most once a minute. Neither polling nor handoff can extend the sandbox beyond its hard lifetime. After a Kernel CDP disconnect, reconnect agent-browser using its configured relay and take a fresh snapshot.

### Test previews and handoffs from your checkout

Use the root `.env` for all five local processes. No separate `apps/*/.env` files are required. Keep the local database, auth, web, and Temporal defaults from `.env.example`, and set these overrides:

```dotenv
RUNNER_EXECUTION_MODE=pi
RUNNER_SANDBOX_PROVIDER=modal
MODEL_CREDENTIALS_ENCRYPTION_KEY=<openssl rand -hex 32>
MODAL_TOKEN_ID=<Modal token ID>
MODAL_TOKEN_SECRET=<Modal token secret>
MODAL_ENVIRONMENT=main
MODAL_APP_NAME=cloud-swe-workspaces
MODAL_IMAGE_NAME=cloud-swe-workspace
GITHUB_CLIENT_ID=<GitHub App client ID>
GITHUB_CLIENT_SECRET=<GitHub App client secret>
GITHUB_APP_SLUG=<GitHub App slug>
PREVIEW_DOMAIN=p.anmolhurkat.com
GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=3002
KERNEL_API_KEY=<Kernel account key>
BROWSER_RELAY_URL=wss://gateway-dev.anmolhurkat.com/cdp
BROWSER_RELAY_SECRET=<a separate openssl rand -hex 32 value>
```

Generate each secret separately, then paste the value into `.env`. Preserve an existing `MODEL_CREDENTIALS_ENCRYPTION_KEY`, because stored provider credentials depend on it. The GitHub App needs the local callback `http://localhost:3000/api/auth/callback/github`, email read permission, and installation access to your test repository. Connect a model provider through onboarding. A worker environment model key does not replace that step.

Route both `*.p.anmolhurkat.com` and `gateway-dev.anmolhurkat.com` over HTTPS to the local gateway on port 3002. The proxy must preserve the original Host and support WebSockets. Use a named tunnel with wildcard routing or a reverse proxy you control. A random tunnel URL alone cannot serve the per-port preview hostnames. Cloudflare Universal SSL covers first-level subdomains such as `3000-<slug>.anmolhurkat.com`; `*.p.anmolhurkat.com` needs an additional certificate. For local development without that certificate, use `PREVIEW_DOMAIN=anmolhurkat.com` and a wildcard tunnel route only if it does not replace an unrelated existing DNS record. If you use a separate development preview domain, change `PREVIEW_DOMAIN` in every process.

For a gateway deployed to Railway, use the deployment steps above and give it access to the same PostgreSQL database as the local API and runner. Its `localhost` cannot reach your local PostgreSQL. Set the same browser group, preview domain, Modal credentials, and idle grace on that gateway.

Publish the updated image before starting a fresh test thread. This command uses paid Modal compute, verifies cold boot and restore, and publishes the image:

```sh
uv run --env-file .env infra/modal/build_image.py
```

After configuring public routing and publishing the image, run:

```sh
bun install
bun run infra:up
bun run db:migrate
```

Start these commands in five separate terminals from the repository root:

```sh
bun run dev:server
bun run dev:runner
bun run dev:dispatcher
bun run dev:web
bun run --cwd apps/gateway dev
```

Open `http://localhost:3001`, finish onboarding, and create a fresh thread on a public test repository. Ask the agent to start a small app, configure its public origins from `PREVIEW_URL_TEMPLATE`, open the preview with agent-browser, and request a browser handoff. Check that the Browser tab shows the page, the preview link opens separately, and **Take control** and **Hand back** work.

To check delayed handoffs, close the Browser panel and all previews until the workspace pauses. Reopen the Browser panel before answering. It must wake the workspace while the question remains pending. Finish the browser step and hand back. A pause stops guest processes, so ask the agent to restart preview servers after an ordinary pause/resume. A replacement Kernel session restores its saved profile; do not assume an interrupted page action completed.

Leave the Git broker, R2, Brave, Firecrawl, and application title key unset for this public-repository, text-only test. Private Git needs the separately configured broker described above. The live test uses Modal, Kernel, and your connected model provider; delete the test thread when finished to remove its workspace, browser, and saved profile.
