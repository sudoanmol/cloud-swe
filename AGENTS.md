# Agent guide

## Project and current scope

Cloud coding agent with durable threads and a Linux workspace per thread. Pi runs on backend workers and operates the sandbox through remote tools. Users can disconnect and return while execution continues or resumes from checkpoints. Single-server resume project.

Read the relevant contract before editing:

- [Backend contract](docs/backend-contract.md): implemented behavior, HTTP/SSE, ownership, recovery, and configuration.
- [Model broker](docs/backend-contract.md#model-broker) and [GitHub broker](docs/github-broker.md): per-user credentials, repository access, approval, and write reconciliation.
- [Effect patterns](docs/effect-patterns.md): how the backend uses Effect.
- [Local setup](docs/local-backend.md) and [sandbox contract](docs/modal-sandbox-spec.md): development and provider workflows.

## Code map

| Path                            | Responsibility                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/server`                   | Fastify host, shutdown, authentication wiring                                               |
| `apps/runner`                   | Node.js Temporal worker/dispatcher, Pi, sandbox adapters                                    |
| `packages/api`                  | Backend routes, authorization, validation, SSE; also contains the browser client            |
| `packages/db`                   | PostgreSQL/Drizzle schema, migrations, transactional thread store                           |
| `packages/auth`, `packages/env` | Better Auth and Zod-validated settings                                                      |
| `apps/web`                      | TanStack Start/React frontend, account-scoped queries, durable event projection and chat UI |
| `infra/modal`                   | Reproducible workspace image build, verification, and publishing                            |

Runner starting points: `activities.ts` owns execution/lifecycle coordination; `pi.ts` integrates the SDK; `pi-writer.ts` serializes persistence; `execution-coordinator.ts` owns remote command reconciliation; `workflows.ts` owns durable orchestration. Confirm their current shape before changing them.

Keep HTTP route modules in `packages/api/src/routers/`: `thread.ts`, `models.ts`, and `git-broker.ts`. GitHub transport and bundle handling live in `packages/api/src/github.ts` and `git-bundles.ts`; runner tools live in `apps/runner/src/git-tools.ts`. The database store is split under `packages/db/src/threads/`, with broker persistence in `model-credentials.ts` and `git-store.ts` beside that directory.

## Naming

- Files are kebab-case (`execution-coordinator.ts`); `apps/web/src/routes` follows TanStack Router file conventions.
- Types, interfaces, and React components are PascalCase without an `I` prefix. Functions and variables are camelCase.
- Fixed module-level limits, prompts, and keys are SCREAMING_SNAKE_CASE, with a unit suffix where one applies (`_MS`, `_BYTES`, `_CHARS`).
- Environment variables are SCREAMING_SNAKE_CASE. Database columns are snake_case and map to camelCase Drizzle fields.

## Invariants

- Thread = durable conversation; run = execution period; workspace = sandbox; connection = disposable SSE reader. Browser lifetime never owns execution. Worker memory is never durable truth.
- PostgreSQL owns messages, runs, ordered events, checkpoints, outbox delivery, and operation ownership. Keep transactional checks and writes together. Preserve idempotent message submission and active-run admission limits.
- SSE replays committed events then tails PostgreSQL. The per-thread event sequence is the cursor, not the event UUID. Preserve `after`/`Last-Event-ID` behavior, slow-client backpressure, and independent readers. Disconnect never cancels a run.
- Temporal owns retries, cancellation, recovery, and idle pause/delete timers. Keep workflows replay-safe and free of Effect runtime imports. Do not send token deltas or stdout chunks through Temporal.
- Route every workspace command through the execution coordinator. The only exception is the read-only review program (diff count and review panel), which never mutates the checkout. A nonzero guest exit is a tool result; transport timeout/cancellation is an ambiguous outcome requiring reconciliation. Never treat local interruption as proof that remote work stopped.
- Preserve workspace generation checks, command fencing, and one mutating run per thread. Pause/delete/replacement must respect active runs and unsettled commands.
- Pi events use project-owned types. Persist resumable session state, drain accepted writes before success, and commit final run state/message/event atomically. Preserve database-issued checkpoint ownership and Zod entry validation; a local queue alone cannot fence stale attempts.
- Git writes require an immutable, owned approval proposal. Keep proposal, checkpoint, and event persistence atomic. Reconcile dispatched writes even after run cancellation; never redispatch an unknown write. Preserve unresolved command failures across Git tools and access refresh.

## Credentials and sandbox

Sandbox code is untrusted. Keep model keys, GitHub credentials, Modal credentials, and application secrets server-side. Never put upstream credentials in images, snapshots, guest environment, commands, or durable errors. Private Git uses the backend broker; guest capabilities are scoped and expiring and cannot approve or execute writes.

Pi runs use per-user encrypted model credentials and an explicit `modelSelection` on every submission, including follow-ups. Do not restore ambient worker-key fallback. The API server and runner share `MODEL_CREDENTIALS_ENCRYPTION_KEY`; preserve the user/provider lock around credential refresh, replacement, and deletion.

Modal is the primary provider; Docker supports local scripted tests. Pi exposes remote shell/read/write/edit and configured GitHub tools. Repository setup accepts GitHub HTTPS URLs, with private access through the broker and anonymous public cloning when it is disabled. Browser automation uses the agent-browser CLI from bash. Previews, frontend broker controls, and external filesystem backups remain separate capabilities.

Lifecycle: create from the published image, prepare repository, execute, pause after idle grace, resume for work. The application never deletes a paused workspace; Modal expires its exit snapshot after 30 days. Pause terminates the sandbox and keeps its filesystem in an exit snapshot; resume restores the files into a new sandbox, and processes do not survive. Every sandbox has a hard Modal timeout, so a failed pause cannot leave it billing indefinitely. Conversation checkpoints do not back up uncommitted files or unpushed commits. Keep machine setup reproducible because provider resources can disappear.

The image recipe uses Ubuntu/root with supervisord, Docker/Compose, a preview forwarder, and the agent-browser CLI connected to the hosted Kernel browser; its skill lives in `/root/.agents/skills`, which discovery scans as global skills beside `/root/.agents/AGENTS.md`. There is no in-guest Chrome. Previews go through the gateway, and CDP uses a scoped relay capability. Do not expose other control endpoints without authorization. See `infra/modal/MANIFEST.md` for actual verified setup. Preserve conservative compute/time limits; never assume provider quotas or free-tier terms are permanent.

## Working and verification

Use Node.js 24, Bun 1.4, and Docker. Inspect `git status` first and preserve unrelated changes. Add, update, or remove dependencies only with `bun add`/`bun remove`/`bun update`; never edit `bun.lock` or other lock files by hand. Read package scripts before running them. Keep fixes scoped; avoid generic forwarding layers and schema/framework migrations for uniformity.

- Setup: `bun install`; create `.env` from `.env.example` only if absent; `bun run infra:up`; `bun run db:migrate`.
- Backend processes: `bun run dev:server`, `bun run dev:runner`, `bun run dev:dispatcher`.
- Checks: `bun run check-types`, `bunx oxlint`, `bunx oxfmt --check`.
- Focused tests: `bun test <test-file>`. Persistence/recovery changes also need `bun run test:db` and `bun run test:backend` against disposable local infrastructure.
- Full local suite: `rg --files apps packages -g '*test.ts' -0 | xargs -0 bun test`. Scope discovery to application directories so reference checkouts are excluded. The backend suite restarts PostgreSQL and Temporal; stop other backend processes and avoid concurrent integration runs.
- `bun run check` writes formatting changes. Prefer formatting only changed files when unrelated work exists.
- Paid tests: `bun run test:backend:paid` requires explicit authorization. Local tests do not certify live Modal behavior or the published image. Any sandbox created by hand must be terminated after use.

Test observable failure/recovery behavior, not implementation structure. Keep Zod validation at external/persistence entry points. Report changed behavior, validation, and unresolved findings. Measure removed plumbing across all affected files; moving code is not a LOC reduction.

## Effect source reference for agents

`repos/effect/` is an ignored local source checkout, not an application dependency or tracked subtree. Reference pin: `effect@4.0.0-rc.113`, commit `d3b837aee836f35d625d55205f7d6e61305fc198` from `https://github.com/Effect-TS/effect.git`.

- Before writing Effect code, read `repos/effect/LLMS.md` if present and inspect relevant source/tests under `packages/effect/`. Use `rg --no-ignore` when searching the ignored checkout. Upstream instructions describe that reference repository; our application rules still govern this project.
- Treat the checkout as read-only. Do not import from it, install its dependencies, run its repository-wide checks, or edit it as application code. Import from the normal `effect` package when adoption is implemented.
- Verify APIs against the pinned source. Avoid mixing v3 docs with v4 RC APIs. When the application pins a different release, update the reference and this pin together.
- On a fresh clone, recreate the ignored checkout with `git clone --depth 1 --branch effect@4.0.0-rc.113 https://github.com/Effect-TS/effect.git repos/effect`. Verify `git -C repos/effect rev-parse HEAD` matches the commit above. Preserve an existing checkout instead of overwriting it.
- Limit Effect to resource scopes, supervised execution, typed failures, ordered persistence, and backend SSE. Keep Zod, Temporal durability, and PostgreSQL invariants.
