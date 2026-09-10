# Run the backend locally

This backend accepts prompts, runs a scripted agent in a Docker workspace, and streams durable events. You do not need model or Freestyle credentials for the local scripted path. The UI is not connected yet.

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

The API accepts requests and serves PostgreSQL state. The dispatcher delivers pending outbox commands to Temporal. The separate `apps/runner` worker processes workflows and activities under Node.js. Its Docker access stays on the host, outside workspace containers.

The first local workspace pulls a pinned Ubuntu 24.04 image. Each container has a CPU, memory, and process limit. Containers have no network, host mounts, Docker socket, or upstream credentials. The local Docker path cannot clone a repository.

Public repository cloning uses the Pi and Freestyle path. Set `RUNNER_EXECUTION_MODE=pi`, `RUNNER_SANDBOX_PROVIDER=freestyle`, `FREESTYLE_API_KEY`, and `AI_GATEWAY_API_KEY` before starting the runner. The Freestyle VM must use the snapshot described in `infra/freestyle/MANIFEST.md`.

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

Thread mutations require the trusted `Origin` and `X-CSRF-Protection: 1` headers. JSON submissions also require `Content-Type: application/json`. Local development allows an unverified email account; production compute requires verified authentication.

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
