# cloud-swe

A cloud coding agent with durable threads, reconnectable event streams, and a Linux workspace per thread.

Pi runs on backend workers. It operates the workspace through remote tools rather than running commands on the worker. PostgreSQL stores conversations, runs, events, checkpoints, and operation ownership. Temporal coordinates execution and workspace lifecycle.

## Stack

- Nuxt and Vue frontend
- Fastify HTTP API with Better Auth
- PostgreSQL and Drizzle
- Temporal workflows and Node.js agent workers
- Pi Coding Agent SDK
- Freestyle Linux VMs, with an isolated Docker provider for local scripted tests

Thread routes use the hand-written `/api/threads` API. Browser connections do not own runs. Closing a stream does not cancel work. The Nuxt frontend is still a starter; connecting it to the thread API is deferred.

## Local development

Use Node.js 24, Bun 1.4, and Docker.

```sh
bun install
cp .env.example .env
bun run infra:up
bun run db:migrate
bun run dev
```

Keep an existing `.env` and merge new settings rather than overwriting it. The web app runs at <http://localhost:3001>, the API at <http://localhost:3000>, and Temporal UI at <http://localhost:8233>.

The default scripted Docker path needs no model or Freestyle credentials. Pi execution needs the server-side credentials and snapshot configuration described in the guides below. Never put upstream credentials in a workspace or snapshot.

## Guides

- [Run the backend locally](docs/local-backend.md)
- [Backend contract](docs/backend-contract.md)
- [Freestyle sandbox and public repository contract](docs/freestyle-sandbox-spec.md)
- [Reliability implementation requirements](docs/backend-reliability-spec.md)
- [Snapshot manifest and rebuild instructions](infra/freestyle/MANIFEST.md)

Workspace deletion is destructive. Uncommitted files and local, unpushed commits are not backed up. Durable conversation history is not a filesystem backup.

## Repository layout

```text
apps/web/       Nuxt frontend
apps/server/    Fastify host
apps/runner/    Temporal worker, dispatcher, Pi and sandbox adapters
packages/api/   HTTP routes, validation and SSE
packages/auth/  Authentication construction
packages/db/    Schema, migrations and durable state
packages/env/   Validated process configuration
infra/         Local services and reproducible VM setup
```

## Validation

```sh
bun run check-types
bun run check
bun run test:db
bun run test:backend
```

Database and backend integration tests use disposable local resources and require PostgreSQL, Temporal, and Docker. The paid Pi/Freestyle suite is opt-in with `bun run test:backend:paid`; run it only with credentials and a disposable provider account.

`bun run check` runs Oxlint and writes formatting changes. `bun run prepare` installs the Git hooks.
