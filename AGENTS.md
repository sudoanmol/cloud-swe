# Agent guide

## Project and current scope

Cloud coding agent with durable threads and a Linux workspace per thread. Pi runs on backend workers and operates the sandbox through remote tools. Users can disconnect and return while execution continues or resumes from checkpoints.

Single-server resume project. Favor readable code and less manual plumbing. Keep the in-memory request limiter; resets on restart are acceptable. Do not add Redis, shared rate limiting, or multi-server infrastructure without a concrete task.

Current focus is backend correctness, simplification, and selective Effect v4 RC adoption. Keep Zod. Leave `apps/web/**`, `packages/api/src/client.ts`, and browser-facing exports unchanged unless explicitly requested. A Nuxt chatbot template integration comes later.

Read the relevant contract before editing:

- [Backend contract](docs/backend-contract.md): implemented behavior, HTTP/SSE, ownership, recovery, and configuration.
- [Adoption spec](docs/effect-adoption-spec.md): planned correctness fixes, Effect scope, simplifications, and acceptance tests. A spec is not evidence that a feature is implemented.
- [Backend review](docs/backend-review-report.md): known findings and their status.
- [Reliability requirements](docs/backend-reliability-spec.md): detailed invariants and recovery cases.
- [Local setup](docs/local-backend.md) and [sandbox contract](docs/freestyle-sandbox-spec.md): development and provider workflows.

## Code map

| Path                            | Responsibility                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `apps/server`                   | Fastify host, shutdown, authentication wiring                                    |
| `apps/runner`                   | Node.js Temporal worker/dispatcher, Pi, sandbox adapters                         |
| `packages/api`                  | Backend routes, authorization, validation, SSE; also contains the browser client |
| `packages/db`                   | PostgreSQL/Drizzle schema, migrations, transactional thread store                |
| `packages/auth`, `packages/env` | Better Auth and Zod-validated settings                                           |
| `apps/web`                      | Nuxt/Vue frontend; outside current scope                                         |
| `infra/freestyle`               | Reproducible golden snapshot setup and verification                              |

Runner starting points: `activities.ts` owns execution/lifecycle coordination; `pi.ts` integrates the SDK; `pi-writer.ts` serializes persistence; `execution-coordinator.ts` owns remote command reconciliation; `workflows.ts` owns durable orchestration. Confirm their current shape before changing them.

## Invariants

- Thread = durable conversation; run = execution period; workspace = sandbox; connection = disposable SSE reader. Browser lifetime never owns execution. Worker memory is never durable truth.
- PostgreSQL owns messages, runs, ordered events, checkpoints, outbox delivery, and operation ownership. Keep transactional checks and writes together. Preserve idempotent message submission and active-run admission limits.
- SSE replays committed events then tails PostgreSQL. The per-thread event sequence is the cursor, not the event UUID. Preserve `after`/`Last-Event-ID` behavior, slow-client backpressure, and independent readers. Disconnect never cancels a run.
- Temporal owns retries, cancellation, recovery, and idle pause/delete timers. Keep workflows replay-safe and free of Effect runtime imports. Do not send token deltas or stdout chunks through Temporal.
- Route every workspace command through the execution coordinator. A nonzero guest exit is a tool result; transport timeout/cancellation is an ambiguous outcome requiring reconciliation. Never treat local interruption as proof that remote work stopped.
- Preserve workspace generation checks, command fencing, and one mutating run per thread. Pause/delete/replacement must respect active runs and unsettled commands.
- Pi events use project-owned types. Persist resumable session state, drain accepted writes before success, and commit final run state/message/event atomically. The adoption spec adds database checkpoint ownership and proper Zod entry validation; a local queue alone cannot fence stale attempts.

## Credentials and sandbox

Sandbox code is untrusted. Keep model keys, GitHub credentials, Freestyle credentials, and application secrets server-side. Never put upstream credentials in snapshots, guest environment, commands, or durable errors. Private Git must eventually use backend credential brokering.

Freestyle is the primary provider; Docker supports local scripted tests. Current Pi tools are remote shell/read/write and repository setup accepts public GitHub HTTPS repositories. Desktop/CUA tools, private Git, previews, and external filesystem backups are separate capabilities, not implied by a working shell tool.

Lifecycle: create from snapshot, prepare repository, execute, pause after idle grace, resume for work, eventually delete. Pause/resume preserves memory; stop/start does not. Conversation checkpoints do not back up uncommitted files or unpushed commits. Keep machine setup reproducible because provider resources can disappear.

The desktop target uses Ubuntu/root/systemd, Docker/Compose, Chromium, X11, Xvfb, Openbox/XFCE, D-Bus/AT-SPI, CUA Driver, and view-only noVNC. Do not expose desktop/control endpoints without authorization. See `infra/freestyle/MANIFEST.md` for actual verified setup. Preserve conservative compute/time limits; never assume provider quotas or free-tier terms are permanent.

## Working and verification

Use Node.js 24, Bun 1.4, and Docker. Inspect `git status` first and preserve unrelated changes. Read package scripts before running them. Keep fixes scoped; avoid generic forwarding layers and schema/framework migrations for uniformity.

- Setup: `bun install`; create `.env` from `.env.example` only if absent; `bun run infra:up`; `bun run db:migrate`.
- Backend processes: `bun run dev:server`, `bun run dev:runner`, `bun run dev:dispatcher`.
- Checks: `bun run check-types`, `bunx oxlint`, `bunx oxfmt --check`.
- Focused tests: `bun test <test-file>`. Persistence/recovery changes also need `bun run test:db` and `bun run test:backend` against disposable local infrastructure.
- `bun run check` writes formatting changes. Prefer formatting only changed files when unrelated work exists.
- Paid tests: `bun run test:backend:paid` requires explicit authorization. Local tests do not certify live Freestyle behavior or a golden snapshot.

Test observable failure/recovery behavior, not implementation structure. Keep Zod validation at external/persistence entry points. Report changed behavior, validation, and unresolved findings. Measure removed plumbing across all affected files; moving code is not a LOC reduction.

## Effect source reference for agents

`repos/effect/` is an ignored local source checkout, not an application dependency or tracked subtree. Reference pin: `effect@4.0.0-rc.113`, commit `d3b837aee836f35d625d55205f7d6e61305fc198` from `https://github.com/Effect-TS/effect.git`.

- Before writing Effect code, read `repos/effect/LLMS.md` if present and inspect relevant source/tests under `packages/effect/`. Use `rg --no-ignore` when searching the ignored checkout. Upstream instructions describe that reference repository; our application rules still govern this project.
- Treat the checkout as read-only. Do not import from it, install its dependencies, run its repository-wide checks, or edit it as application code. Import from the normal `effect` package when adoption is implemented.
- Verify APIs against the pinned source. Avoid mixing v3 docs with v4 RC APIs. When the application pins a different release, update the reference and this pin together.
- On a fresh clone, recreate the ignored checkout with `git clone --depth 1 --branch effect@4.0.0-rc.113 https://github.com/Effect-TS/effect.git repos/effect`. Verify `git -C repos/effect rev-parse HEAD` matches the commit above. Preserve an existing checkout instead of overwriting it.
- Limit Effect to the adoption spec: resource scopes, supervised execution, typed failures, ordered persistence, and backend SSE. Keep Zod, Temporal durability, and PostgreSQL invariants.
