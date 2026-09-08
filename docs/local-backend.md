# Run the backend locally

This backend accepts prompts, runs a scripted agent in a Docker workspace, and streams durable events. You do not need model or Freestyle credentials. The UI is not connected yet.

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

The first workspace creation pulls a pinned Ubuntu 24.04 image. Each container has a CPU, memory, and process limit. Containers have no network, host mounts, Docker socket, or upstream credentials.

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

Submit a prompt:

```sh
curl -sS -b /tmp/cloud-swe.cookies \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Check the workspace","clientMessageId":"local-demo-1"}' \
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
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Run the check again","clientMessageId":"local-demo-2"}' \
  http://localhost:3000/api/threads/THREAD_ID/messages
```

Cancel a run:

```sh
curl -sS -X POST -b /tmp/cloud-swe.cookies \
  http://localhost:3000/api/threads/THREAD_ID/runs/RUN_ID/cancel
```

Cancellation returns `202`. Wait for `run.cancelled` or inspect the run state to observe completion of cancellation.

## Verify recovery

```sh
bun run test:db
bun run test:backend
bun run check-types
```

The tests use disposable databases, real authentication, the local Temporal service, and labeled Docker workspaces. The backend suite restarts the development services to exercise recovery. Run it against local development infrastructure, with other local backend processes stopped. It removes its own test resources afterward.

## Stop the services

Stop the application processes with Ctrl-C. Then stop the infrastructure without deleting data:

```sh
bun run infra:stop
```

Inspect health and logs with `docker compose ps` and `bun run infra:logs`.

`docker compose down` removes service containers while preserving volumes. Adding `--volumes` deletes the local PostgreSQL and Temporal data.

The Compose ports bind to localhost. Temporal's development server is not a production deployment configuration.
