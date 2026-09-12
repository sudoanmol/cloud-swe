# Run the backend locally

This backend accepts prompts, runs a scripted agent in a Docker workspace, and streams durable events. You do not need model or Freestyle credentials for the local scripted path. The Nuxt UI uses the same REST and SSE endpoints.

Use Docker, Node.js 24, and Bun 1.4.

## Start PostgreSQL and Temporal

```sh
bun install
bun run infra:up
```

Compose starts PostgreSQL on `127.0.0.1:5432`, Temporal on `127.0.0.1:7233`, and the Temporal UI at <http://localhost:8233>. Both services store their data in Docker volumes. The pinned Temporal image runs its development server with a persistent SQLite database.

If you do not have the root environment file, create it from the example:

```sh
cp .env.example .env
```

If that file already exists, merge the example settings into it. Set `DATABASE_URL` to `postgresql://postgres:password@localhost:5432/cloud-swe`. The server, runner, database tools, and web build all load this one root file.

Apply the migrations:

```sh
bun run db:migrate
```

These migrations include the original authentication tables and target a fresh database. An existing database created with `db:push` needs a migration baseline before applying the initial migration. Do not delete existing data to work around a migration error.

## Start the application processes

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

The Nuxt UI is at <http://localhost:3001>. Use that host, not `127.0.0.1`, because CORS and cookies are bound to `CORS_ORIGIN`. `bun run dev` starts the server, web app, and worker. Start the dispatcher separately with `bun run dev:dispatcher`.

The API accepts requests and serves PostgreSQL state. The dispatcher delivers pending outbox commands to Temporal. The separate `apps/runner` worker processes workflows and activities under Node.js. Its Docker access stays on the host, outside workspace containers.

The first local workspace pulls a pinned Ubuntu 24.04 image. Each container has a CPU, memory, and process limit. Containers have no network, host mounts, Docker socket, or upstream credentials. The local Docker path cannot clone a repository.

Public repository cloning uses the Pi and Freestyle path. Set `RUNNER_EXECUTION_MODE=pi`, `RUNNER_SANDBOX_PROVIDER=freestyle`, `FREESTYLE_API_KEY`, and `AI_GATEWAY_API_KEY` before starting the runner. The Freestyle VM must use the snapshot described in `infra/freestyle/MANIFEST.md`.

## Workspace timers

A completed run with no queued messages starts a 30-second idle grace period.
The worker then pauses the workspace. After another hour without queued work,
it deletes demo workspaces. Owner workspaces remain paused under provider retention. Closing a browser does not start these timers while
an agent is still working. Background dev servers do not count as agent work.

A follow-up before deletion resumes the same files and processes. A follow-up
after deletion creates a new workspace, clones the public repository again,
and restores the conversation with a reset instruction. Local unpushed work
is lost on deletion.

Freestyle demo VMs use `FREESTYLE_MAX_RUN_SECONDS=1200` for twenty minutes of continuous runtime, plus a cumulative lifetime cap tied to their PostgreSQL reservation. Owner VMs use `FREESTYLE_OWNER_MAX_RUN_SECONDS=4500`, or seventy-five minutes. Both roles disable automatic provider restart. `FREESTYLE_AUTO_DELETE_SECONDS=14400` retains unused demo VMs for four hours; owners restore the plan retention with `autoDeleteSeconds: -1`. Application idle deletion normally removes paused demo VMs first.

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

Thread mutations require the trusted `Origin` and `X-CSRF-Protection: 1` headers. JSON submissions also require `Content-Type: application/json`. Local development allows an unverified email account unless `ALLOW_UNVERIFIED_COMPUTE=false`. Production compute requires a verified email or a GitHub account created through the configured GitHub App.

Use a GitHub App, not a legacy OAuth App. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from the App's user authorization Client ID and client secret. Callback URL: `{BETTER_AUTH_URL}/api/auth/callback/github` (local example: `http://localhost:3000/api/auth/callback/github`). Grant **Account permissions → Email addresses → Read-only**. Better Auth still calls `GET /user/emails` after the token exchange. Do not configure OAuth scopes; GitHub App user tokens use App permissions and return an empty `scope`. The login page shows Continue with GitHub only when `GITHUB_CLIENT_ID` is present in the environment Nuxt loads. Restart the web process after changing that value. Repository installation tokens remain a separate server-side Git broker.

Submit a prompt:

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'X-CSRF-Protection: 1' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Check the workspace","clientMessageId":"local-demo-1"}' \
  http://localhost:3000/api/threads
```

To start a Freestyle Pi run from a public GitHub branch, add `repositoryUrl` and `branch` to the initial request. The follow-up endpoint does not accept either field.

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'X-CSRF-Protection: 1' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Inspect the project","clientMessageId":"freestyle-demo-1","repositoryUrl":"https://github.com/owner/repository","branch":"main"}' \
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

Deleting a workspace loses uncommitted files and local, unpushed commits. A later run gets a new filesystem generation and a reset instruction; only the conversation and checkpoints are durable outside the VM.

## Verify recovery

```sh
bun run test:db
bun run test:backend
bun run check-types
```

The tests use disposable databases, real authentication, the local Temporal service, and labeled Docker workspaces. The backend suite restarts the development services to exercise recovery. Run it against local development infrastructure, with other local backend processes stopped. It removes its own test resources afterward.

## Apply audit command scheduling

Migration `0010_audit_command_scheduling.sql` changes command admission and guest fencing together. Stop new submissions, drain or cancel runs, and reconcile outstanding commands before stopping the old API, dispatcher, and workers. Preserve ownership records for any unresolved operation.

Apply migrations with `bun run db:migrate`, then start all three updated backend processes. The database migration role needs permission to install PostgreSQL's `btree_gist` extension. The migration retains legacy operations as exclusive, adds read slots and a durable command queue, and removes unused `outbox.payload` data.

Do not mix old workers with the new schema and guest protocol. The `recovery-cancellation-scope-v1` and `finalizer-failure-code-v1` patches preserve tested pre-audit workflow histories. They do not establish compatibility with every older release; follow the upgrade procedure below when crossing those releases.

## Apply checkpoint ownership fencing

Stop old workers before applying migration `0008_checkpoint_ownership.sql`. New checkpoint writes and attempt-driven completion require a database-issued ownership token. There is no tokenless compatibility path for old workers. Historical checkpoints remain readable; resumed work obtains ownership before writing.

The Effect adoption preserves representative existing workflow histories. This does not establish compatibility with older releases that changed workflow commands. Follow the existing upgrade procedure below when crossing those releases.

## Upgrade an existing backend

This schema migration and workflow change are not a rolling upgrade. Do not start the new worker against open histories produced by the old workflow implementation. Keeping an activity export with the same name does not establish replay compatibility.

Before upgrading, stop accepting new compute requests. Keep the old dispatcher and worker running until queued and active runs finish or complete cancellation. Resolve outstanding commands and pause the workspaces before stopping those processes. Close the remaining idle workflows using the old deployment, or terminate them only after confirming they have no active run or pending workspace operation. Preserve PostgreSQL data and Temporal history.

Stop the old API, dispatcher, and worker before applying migrations. Start the new deployment only after migration succeeds. New messages use the durable thread data and start new workflow executions. Verify that a follow-up message on an existing thread works before reopening admission.

If an operation cannot be reconciled, keep admission disabled for that workspace. Do not clear its ownership records or reset its generation merely to get the upgrade through. Deployments that cannot drain need workflow versioning and replay tests before using this release.

## Stop the services

Stop the application processes with Ctrl-C. Then stop the infrastructure without deleting data:

```sh
bun run infra:stop
```

Inspect health and logs with `docker compose ps` and `bun run infra:logs`.

`docker compose down` removes service containers while preserving volumes. Adding `--volumes` deletes the local PostgreSQL and Temporal data.

The Compose ports bind to localhost. Temporal's development server is not a production deployment configuration.

## Activate owner and visitor policies

Do not apply the admission migration while old workers are running.

1. Disable new submissions at the ingress and drain active workers.
2. Apply `0009_demo_policy` with `bun run db:migrate`.
3. Set `MAX_ACTIVE_RUNS=5`, `FREESTYLE_VM_LIMIT=5`, and `RUNNER_ACTIVITY_CONCURRENCY=10`. The runner pool derives its size as twice activity concurrency plus four, or 24 by default.
4. Set demo execution to `RUNNER_MAX_RUN_MS=600000`, preparation to `RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS=420000`, and `FREESTYLE_MAX_RUN_SECONDS=1200`. Use `RUNNER_ACTIVITY_RETRY_WINDOW_MS=1900000`.
5. Set `RUNNER_OWNER_MAX_RUN_MS=3600000`, `FREESTYLE_OWNER_MAX_RUN_SECONDS=4500`, and `DEMO_MONTHLY_VM_SECONDS=18000`.
6. Replace the example `PRIMARY_GITHUB_ACCOUNT_ID` with the owner’s confirmed linked numeric GitHub account ID, or leave it unset to grant no owner privileges. Never substitute a login name or email.
7. Verify the account's actual running and total VM limits, including paused VMs and temporary builders. Keep Free billing unchanged. Raise the application ceiling to ten only after confirming the provider limit changed.
8. Reconcile managed VM settings before reopening submissions. Each preparation and Pi retry checks its runtime policy before execution. Keep reservations for ambiguous provider outcomes. Review historical or unlabelled resources separately; do not delete `builder-test` during this rollout.
9. Restart the server, dispatcher, and workers, then reenable submissions.

Existing workflow histories use the `owner-demo-policies-v1` Temporal patch. New workflow scheduling includes the owner safety window. PostgreSQL owns each run's execution-start timestamp, so activity retries do not restart its deadline. Paused owner workflows wait for another signal without scheduling deletion.

The app's demo budget resets at UTC calendar-month boundaries. Freestyle's billing-cycle reset is separate. The budget excludes model API charges. Provider failure-code mappings and cumulative-runtime behavior still require live verification before activation; local doubles cannot certify them.

Run local checks with `bun run test:db`, `bun run test:backend`, and `bun test apps/runner/tests/demo-policy.test.ts apps/runner/tests/remote-tools.test.ts apps/runner/tests/snapshot-resources.test.ts`. Backend integration builds `apps/runner/tests/Dockerfile`, an Ubuntu/Python test image. Runtime containers remain network-disabled. No frontend changes or frontend verification are part of this implementation.
