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

Thread routes use the hand-written `/api/threads` API. The backend exposes REST and SSE endpoints for the planned frontend integration. Browser connections do not own runs, and closing a stream does not cancel work.

## Local development

Use Node.js 24, Bun 1.4, and Docker.

```sh
bun install
test -f .env || cp .env.example .env
bun run infra:up
bun run db:migrate
```

Run each process in a separate terminal:

```sh
bun run dev:server
bun run dev:runner
bun run dev:dispatcher
bun run dev:web
```

Keep an existing `.env` and merge new settings rather than overwriting it. The web app runs at <http://localhost:3001>, the API at <http://localhost:3000>, and Temporal UI at <http://localhost:8233>. Open the UI as `localhost`, not `127.0.0.1`, so it matches `CORS_ORIGIN`. Local email/password works without GitHub. Production login uses GitHub App user OAuth. Set the App Client ID and client secret, callback `{BETTER_AUTH_URL}/api/auth/callback/github`, and Email addresses Read-only. Do not create a legacy OAuth App.

The default scripted Docker path needs no model or Freestyle credentials. Pi execution needs the server-side credentials and snapshot configuration described in the guides below. Never put upstream credentials in a workspace or snapshot.

Model authentication uses per-user encrypted credentials for Vercel AI Gateway, OpenRouter, or ChatGPT device OAuth. Each Pi submission selects a provider, model, and thinking level. The GitHub broker supports private clone/fetch and requires approval for pushes and PR writes. Broker controls are available through the API; frontend controls remain separate work.

## Guides

- [Run the backend locally](docs/local-backend.md)
- [Backend contract](docs/backend-contract.md)
- [Model broker API and credential setup](docs/backend-contract.md#model-broker)
- [GitHub broker configuration and approvals](docs/github-broker.md)
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
                Route modules live in src/routers/
packages/auth/  Authentication construction
packages/db/    Schema, migrations and durable state
packages/env/   Validated process configuration
infra/         Local services and reproducible VM setup
```

## Validation

```sh
bun run check-types
bunx oxlint
bunx oxfmt --check
bun run test:db
bun run test:backend
```

Run all local test files, excluding the paid suite and reference checkouts:

```sh
rg --files apps packages -g '*test.ts' -g '!pi-freestyle.test.ts' -0 | xargs -0 bun test
```

Database and backend integration tests use disposable local resources and require PostgreSQL, Temporal, and Docker. The paid Pi/Freestyle suite is opt-in with `bun run test:backend:paid`; run it only with credentials and a disposable provider account.

The backend suite restarts local PostgreSQL and Temporal. Stop other backend processes before running it, and do not run another integration suite alongside it.

`bun run check` runs Oxlint and writes formatting changes. `bun run prepare` installs the Git hooks.

Owner/demo access, resource budgets, remote editing, and scoped Pi resources are described in [the backend contract](docs/backend-contract.md). Follow [the rollout steps](docs/local-backend.md#activate-owner-and-visitor-policies) before activation. The example environment contains a numeric owner ID; set `PRIMARY_GITHUB_ACCOUNT_ID` to your own linked GitHub account ID or leave it unset to grant no owner privileges. Provider limits default to five VMs. The frontend stub will be replaced separately by a chatbot template.
