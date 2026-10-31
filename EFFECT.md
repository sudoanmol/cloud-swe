# Effect v4 evaluation

Evaluated and trialled 2026-10-29 against Effect's `effect@4.1.0` release tag. **The focused workspace integration is implemented; the broader feature suggestions below remain proposals.**

Effect is a useful candidate for application-side asynchronous orchestration, not a replacement for Pi Durable, PiHarness/Lifecycle, Durable Object storage or Boat. The linked [agent/source article](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive) recommends giving coding agents local dependency source; it does not establish application reliability guarantees.

## Implemented trial

- `server/package.json` pins `effect@4.1.0`. Its exact version is excluded from pnpm's minimum release-age gate because it was released on the evaluation date.
- Workspace functions now return lazy `Effect` values with a `WorkspaceError` failure channel (`configuration`, `unavailable`, `invalid_response`). Existing async SDK/fetch adapters stay ordinary Promise functions and observe the abort signal supplied by Effect.
- `Effect.retry` replaces Boat's manual retry loop: only the exact `idempotency_in_progress` code is retried, at most ten total attempts, one second apart, using the same body/key. The old substring check could retry an unrelated error whose message mentioned that code; a regression test now prevents that. Network/5xx errors still surface without automatic retries.
- `Effect.repeat` replaces readiness polling: at most 30 inspections, two seconds apart. Effect enforces 30-second create-request and five-second inspection timeouts, plus two-minute create and one-minute readiness deadlines. A timed-out create may still have happened remotely; retries retain the original operation ID.
- The session-creation boundary uses `Effect.runPromise`, converts expected failures to the existing sanitized 503 response, and preserves intent/mapping persistence. Unexpected Effect defects are not swallowed by that expected-error handler. No HTTP contract or stored-record shape changed.
- `TestClock` drives retry exhaustion, delayed readiness, request/overall deadlines and cancellation. Actual Docker/workerd/Miniflare tests still exercise creation, concurrent/lost-receipt retries and restart persistence.
- Tool polling and SSE now use Effect too. `pollCommand` (`server/src/tools/command-records.ts`) composes `Effect.retry`, `Effect.repeat` and `Effect.timeout` instead of a handwritten loop. `events` (`server/src/sessions/events.ts`) uses `Stream.merge`, `Stream.tick` and `Stream.groupedWithin` with `Effect.acquireRelease` for watch cleanup.

This is not an application rewrite: no services/layer graph, long-lived ManagedRuntime, Effect AI loop, workflow engine, telemetry exporter or source subtree was added. The subsequent slice-1 recovery increment now looks up a lost sandbox ID by exact name before provisioning; see the reliability limits below.

## Measured trade-offs

Compared with Git baseline `91f9eae397b3e0049f53f47152125f1799a67465`, including new files and excluding lockfiles:

| Metric                                   | Before       | After        | Change                        |
| ---------------------------------------- | ------------ | ------------ | ----------------------------- |
| Changed production TS files, total lines | 317          | 366          | +49 (+43 server, +6 protocol) |
| Changed test files, total lines          | 312          | 523          | +211                          |
| Passing protocol/server tests            | 9 / 13       | 10 / 21      | +9                            |
| Worker dry-run upload, unminified        | 2,411.42 KiB | 2,698.81 KiB | +287.39 KiB                   |
| Same Worker upload, gzip                 | 397.36 KiB   | 457.93 KiB   | +60.57 KiB                    |

**No line-count reduction.** Two handwritten loops and two broad async catch blocks disappeared, but typed failures, adapter signal plumbing and stronger validation/deadlines made the production code slightly larger. The gain is composable, cancellation-aware policy and deterministic failure tests, not fewer lines or automatic durability. Bundle measurements use the same Docker `build:test` command before/after; no CPU/startup benchmark was performed.

Checks passed: the full Docker suite (`pnpm test`, including protocol tests, typechecks, Worker bundling and Miniflare integration), lint, knip and formatting on changed files. Repository-wide `pnpm fmt:check` still flags four files unchanged from the baseline: `protocol/SOURCE-VERIFICATION.md`, `protocol/tsconfig.json`, `server/tsconfig.json` and `server/wrangler.jsonc`; unrelated formatting was left alone. No live Boat or paid model calls were used.

## Where to look for Effect code

Start with this implementation:

| Path                                                                 | What to read                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`server/src/workspaces/index.ts`](server/src/workspaces/index.ts)   | Effect/Promise interop, readiness repetition and deadlines                                   |
| [`server/src/workspaces/boat.ts`](server/src/workspaces/boat.ts)     | Selective retries, SDK abort propagation and validated create responses                      |
| [`server/src/workspaces/errors.ts`](server/src/workspaces/errors.ts) | Tagged domain failures and normalization of transport/timeouts                               |
| [`server/src/sessions/create.ts`](server/src/sessions/create.ts)     | Coarse `runPromise` boundary without changing DO persistence                                 |
| [`server/test/workspace.test.ts`](server/test/workspace.test.ts)     | `TestClock`, child fibers, retry bounds, abort/deadline tests and real Docker adapter checks |
| [`server/src/workspaces/boat.ts`](server/src/workspaces/boat.ts)     | Zod remains authoritative for upstream envelopes, including the retryable Boat error code    |

For idiomatic upstream examples, use the [release-pinned `LLMS.md`](https://github.com/Effect-TS/effect/blob/effect@4.1.0/LLMS.md) as the index:

- [Retries and schedules](https://github.com/Effect-TS/effect/blob/effect@4.1.0/ai-docs/src/06_schedule/10_schedules.ts).
- [Promise/callback interop](https://github.com/Effect-TS/effect/blob/effect@4.1.0/ai-docs/src/01_effect/01_basics/10_creating-effects.ts).
- [Resource scopes](https://github.com/Effect-TS/effect/blob/effect@4.1.0/ai-docs/src/01_effect/05_resources/10_acquire-release.ts).
- [Hono/ManagedRuntime integration](https://github.com/Effect-TS/effect/blob/effect@4.1.0/ai-docs/src/04_integration/10_managed-runtime.ts), if shared services eventually justify a runtime.
- [Streams](https://github.com/Effect-TS/effect/blob/effect@4.1.0/ai-docs/src/03_stream/10_creating-streams.ts), for later SSE/runner work.
- [Core behavior tests](https://github.com/Effect-TS/effect/blob/effect@4.1.0/packages/effect/test/Effect.test.ts) and [TestClock implementation/examples](https://github.com/Effect-TS/effect/blob/effect@4.1.0/packages/effect/src/testing/TestClock.ts).

Locally, the installed package has source at `server/node_modules/effect/src/`. The reusable full checkout is `$HOME/.cache/checkouts/github.com/Effect-TS/effect/`; it includes `LLMS.md`, `ai-docs/` and upstream tests. That checkout follows upstream, so inspect the `effect@4.1.0` tag rather than assuming its current `main` matches the installed package. Never import application code from the reference checkout.

## Original recommendation and remaining opportunities

The initial recommendation targeted `server/src/workspaces/` and the provisioning boundary in `server/src/sessions/create.ts`, preserving the HTTP and persisted contracts:

- **Typed operational failures:** distinguish an in-progress idempotent create, transient transport/server failure, reused idempotency key, invalid configuration, invalid upstream response and unknown provisioning outcome. Effect's error channel makes recovery policies visible in signatures. Keep external `ApiError` responses sanitized; unexpected defects must not become retryable dependency failures.
- **Schedules, deadlines and cancellation:** replace the two handwritten retry/poll loops with bounded, selective policies and an overall deadline. Forward Effect's abort signal to SDK/fetch calls. Retry create only with the same body/key inside the recorded idempotency window; never apply a blanket retry around provisioning plus persistence or an unsafe command.
- **Deterministic time tests:** use `effect/testing`'s `TestClock` for retry exhaustion, delayed readiness and interruption without real one/two-second sleeps. Preserve the Docker/Miniflare restart tests and opt-in Boat checks; a virtual clock does not test platform recovery.
- **Observability:** add correlated spans and sanitized structured diagnostics for operation/session/workspace IDs, retries and latency. Do not attach raw SDK request objects, credentials or provider errors to logs or checkpoints.

Before the trial, the server had roughly 530 production TypeScript lines. A rewrite is not justified just to shorten two loops. Keep the trial only if it improves the failure model and tests, not merely if it changes `await` to `yield*`. A small typed-error union and abort-aware helpers remain a valid dependency-free alternative.

Keep Hono and the Zod-based `protocol/` as the boundary authorities. Effect can consume the parsed values; do not maintain duplicate Zod/Effect schemas. Use `Effect.runPromise`/`runPromiseExit` at coarse application boundaries, mapping typed failures before returning to Hono. Introduce `Context`/`Layer` and a DO-owned `ManagedRuntime` only when shared services/resources justify them; never put a particular DO's storage/context in an isolate-global runtime.

## Later features

| Feature                                   | Potential Effect contribution                                                                                   | Authority that must remain elsewhere                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell tools and cancellation              | Scoped monitoring/output tasks, abort propagation and cleanup                                                   | Pi owns the run; persisted `CommandRecord` plus the runner reconcile remote execution. Aborting HTTP does not prove the command stopped       |
| Snapshot/SSE                              | Stream composition, heartbeat lifetime, bounded subscriber queues and disconnect cleanup                        | Pi remains the transcript; atomically snapshot/subscribe and explicitly close/resnapshot slow clients. In-memory PubSub is not durable replay |
| Lifecycle and retention                   | Testable policy, bounded reconciliation batches and retry classification                                        | Catalog storage owns reservations/cap; DO alarms own durable wakeups. A fiber/semaphore/timer is not a durable reservation or alarm           |
| Claude runner/Mac bridge                  | Stronger fit for scoped subprocesses, concurrent stdout/stderr/events, transport reconnect and resource cleanup | Official engine owns its session; runner receipts, session files and generation-bound approvals survive/reconcile restart                     |
| Fork/restore/snapshot/bootstrap pipelines | Workflow/Activity may express checkpointed application provisioning steps                                       | Requires a durable engine and host/wakeup integration; external effects still need idempotency/reconciliation                                 |
| API/model quotas and dependency outages   | Rate limiter/circuit breaker modules, if usage warrants them                                                    | Cross-DO limits need shared authoritative state; process-local state cannot enforce the account-wide sandbox cap                              |
| Future TS clients                         | HttpApi can derive validation, OpenAPI and typed clients from a single API definition                           | Would be a deliberate schema/router migration, not an extra parallel contract; native iOS still needs a compatible contract/codegen path      |

Do not add Effect AI/Chat as another model loop around Pi or the official Claude runner, or Effect Cluster as another owner for existing Thread entities. These overlap the selected architecture rather than filling a missing capability.

## Reliability limits and version discipline

- Ordinary Effects, fibers, scopes, queues and schedules are in-memory. They do not survive eviction, restart, forced termination or a Boat stop. Finalizers help orderly cleanup but are not guaranteed after a hard crash.
- Do not make a session's persistent sandbox a request-scoped `acquireRelease` resource: closing an HTTP request must not delete it. Losing a client connection after admission must not cancel an accepted durable run.
- The creation path currently persists intent and the returned sandbox mapping; `ensureWorkspace` refuses a new create after 23 hours without a mapping. The subsequent recovery increment first looks up `cloud-swe-<workspaceId>` under a five-second abort-aware Effect deadline. It requires complete pagination metadata and a unique exact name match, fails closed on ambiguity or lookup errors, and recovers existing IDs even beyond the retry margin. No match after the margin remains uncertain. Effect still does not invent an exactly-once command API.
- Effect Workflow is a separate durable execution facility, not automatic persistence for arbitrary Effects. Its in-memory engine is explicitly non-durable; a production engine must persist state and arrange recovery/wakeups. Only completed activities are memoized, and external side effects can repeat.
- Effect provides `@effect/sql-sqlite-do` for DO SQLite. This is a database driver, not by itself a DO-hosted workflow engine; it does not replace Pi's existing SQLite adapter.
- v4 core is stable, but Workflow/Activity, Cluster, HTTP/HttpApi, process, persistence rate limiting/circuit breaking and the DO SQL driver inspected here are marked unstable. Use current per-module `@stability` annotations, not an old beta import-path rule; pin the selected release and consult its `LLMS.md` and examples. Current v4 examples use `Context`, not the earlier beta's `ServiceMap` naming.
- The source-access advice already partly exists here through cached upstream checkouts and `protocol/SOURCE-VERIFICATION.md`. Prefer a version-pinned cached checkout initially; a read-only subtree is useful if references must travel with every clone/cloud sandbox. Never import from it, and exclude it from application tooling/build contexts. No subtree is needed merely to evaluate the library.

## Sources

Release-pinned where applicable: [v4 release status](https://effect.website/blog/this-week-in-effect/139), [Effect primitives](https://github.com/Effect-TS/effect/blob/effect@4.1.0/packages/effect/src/Effect.ts), [retry policy example](https://github.com/Effect-TS/effect/blob/effect@4.1.0/ai-docs/src/06_schedule/10_schedules.ts), [Hono integration](https://github.com/Effect-TS/effect/blob/effect@4.1.0/ai-docs/src/04_integration/10_managed-runtime.ts), [TestClock](https://github.com/Effect-TS/effect/blob/effect@4.1.0/packages/effect/src/testing/TestClock.ts), [WorkflowEngine](https://github.com/Effect-TS/effect/blob/effect@4.1.0/packages/effect/src/workflow/WorkflowEngine.ts), [Activity replay caveat](https://github.com/Effect-TS/effect/blob/effect@4.1.0/packages/effect/src/workflow/Activity.ts), [DO SQLite driver](https://github.com/Effect-TS/effect/blob/effect@4.1.0/packages/sql/sqlite-do/src/SqliteClient.ts), [module guidance](https://github.com/Effect-TS/effect/blob/effect@4.1.0/LLMS.md).

The trial was exercised in Docker/Miniflare and compared using Worker bundle output. Live Boat behavior, CPU/startup performance, paid model execution and the later feature proposals were not tested.
