# Backend correctness, simplification, and Effect adoption specification

Status: implemented locally; changes remain uncommitted at the user's request. See the [implementation report](effect-adoption-report.md) for behavior, verification, size accounting, and deployment requirements. The full repository typecheck retains the documented pre-existing frontend TS2589 error; backend checks pass.

## Objective

Fix the three correctness issues identified in the backend review, simplify the affected backend modules, and use Effect v4 RC for resource ownership, cancellation, Pi persistence, and server-side event streaming. Each migrated module must replace existing coordination code and preserve the backend's durable behavior except for the explicit correctness fixes below.

Keep Zod for configuration, HTTP validation, persisted data, and project contracts. Effect adoption does not require Effect Schema.

This specification narrows the earlier broad migration proposal. The [backend contract](backend-contract.md) and [reliability requirements](backend-reliability-spec.md) remain authoritative for externally observable behavior.

This is a single-server resume project. Keep the existing in-memory request limiter. Counter resets on restart are an accepted limitation, and shared rate limiting, Redis, and multi-server readiness are outside this work. Existing database compute admission remains in place.

All frontend code remains unchanged, including `apps/web/**`, `packages/api/src/client.ts`, and browser-facing exports. The planned Nuxt chatbot template integration is separate work. Preserve the HTTP routes, response shapes, SSE event format, and reconnect cursor behavior it will consume.

## Included scope

| Area                  | Effect tools                                 | Existing code to replace                                                                                   |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Runner resources      | Scope, acquisition/release, finalizers       | Connection, lock, subscription, and session cleanup spread across `activities.ts`, `pi.ts`, and `index.ts` |
| Execution supervision | Fibers, interruption, `Effect.gen`           | Heartbeat timers, detached promises, and repeated cancellation wiring                                      |
| Pi persistence        | Queue, Stream, Deferred                      | `OrderedPiWriter`, promise tails, drain polling, and repeated failure latches                              |
| Runner failures       | Tagged errors and typed handlers             | Repeated internal exception classification along migrated execution paths                                  |
| Server event feed     | Stream, scoped consumption, local scheduling | PostgreSQL polling and connection cleanup in `packages/api/src/routers/thread.ts`                          |
| Timing tests          | TestClock and supplied test dependencies     | Real sleeps in new tests for local scheduling and interruption                                             |

`Context.Service` and `Layer` are limited to shared dependencies used by migrated runner modules. Small local helpers continue to accept explicit arguments. `Schedule` is limited to local heartbeat and polling behavior in this scope.

The correctness fixes and structural simplifications below are also required. They use ordinary TypeScript, PostgreSQL, and Zod where appropriate; they do not require additional Effect abstractions.

## Excluded scope

- Effect Schema, Config, and a general validation migration.
- A logging or OpenTelemetry migration. Keep Pino; targeted diagnostic redaction is included in the credential-leak fix.
- Any frontend or browser SSE client changes, including installing `eventsource-parser` or introducing the Nuxt template.
- Changing authentication behavior or adding a generic route framework. Targeted backend hook and error-response consolidation is included.
- Rewriting the dispatcher delivery algorithm, sandbox SDKs, or Drizzle as a persistence layer. Targeted store/schema changes for checkpoint ownership and validation are included.
- Shared rate limiting, new rate-limiter dependencies, Redis, and multi-server readiness work.
- Effect inside Temporal workflow execution, including indirect runtime imports.
- Replacing database locks, transactions, command reconciliation, or durable events with in-memory constructs.
- Generic Effect wrappers for every SDK method, a new dependency-injection framework, or a new shared Effect package.
- Converting pure helpers into effects or replacing short switches with `Match` for style alone.
- Token batching, event coalescing, and changes to checkpoint frequency. Versioned checkpoint validation and its compatibility handling are included.

## Required correctness fixes

These requirements resolve the three applicable findings in the [backend review](backend-review-report.md). They must be implemented and tested before replacing the Pi persistence writer. Effect's in-memory ordering cannot establish these guarantees.

### Prevent credential leakage through failures

`sanitizeFailureMessage` in `apps/runner/src/pi-writer.ts` can leave a bearer token visible after replacing only the word `Bearer`. Existing error text can reach durable failures and checkpoints.

Replace raw-error-to-public-message conversion with a small shared mapping of stable error codes to bounded, allowlisted messages. Unknown errors receive a generic message. Apply this to existing failure paths as well as new Effect errors, including workflow finalization, HTTP error responses, and error fields written into events or checkpoints. Preserve existing status codes and recovery classifications.

Keep this mapping in plain TypeScript that Temporal workflows can import safely. Do not attach raw causes, provider headers, or response bodies to serialized Temporal failures. Audit SDK-generated error fields in Pi session checkpoints so secret-bearing failure text cannot bypass the public formatter through session persistence.

Use existing Pino logging for diagnostic context. Prefer selected structured fields; apply logger redaction where structured credential fields can appear. Do not log arbitrary SDK errors on the assumption that Pino can remove secrets embedded in every string. Regex sanitization, if retained, is defense in depth and never the basis for a public-message guarantee.

Regression tests must exercise real failure-to-persistence and failure-to-response paths with synthetic bearer/basic authorization, multiple cookies, quoted values, multiline headers, nested causes, and credential-bearing URLs. Assert that the synthetic secrets are absent from public messages, persisted failure fields, serialized failures, and captured diagnostic logs. Existing stored data remediation is outside this forward-write fix.

### Fence checkpoint writes from stale attempts

`saveCheckpoint` in `packages/db/src/threads.ts` currently permits an older attempt to replace a newer checkpoint within the same workspace generation. The conflict update can also replace or trim checkpoint entry rows.

Add a database-issued execution ownership epoch or token. Claim ownership under the existing execution/advisory-lock protocol when a checkpoint-producing activity starts. Persist the owner identity and token atomically. A repeated claim by the current owner is idempotent; a superseded attempt must not reclaim ownership merely by retrying its writes. Attempt IDs remain identities, not lexically ordered versions.

Require the token on every checkpoint write, including preparation, execution-started, scripted, Pi session, and completion checkpoints. Pass the immutable token through the whole attempt and its queued writes. In the same transaction as the mutation, verify current ownership, active run state, and workspace generation before changing checkpoint metadata or entry rows. Ownership changes and writes must use a common lock order so the check cannot race with replacement.

Reject stale writes with a stable ownership-lost error. Stop the stale attempt without allowing it to overwrite or finalize a newer owner's work. Apply ownership checks to attempt-driven completion where necessary; preserve workflow-owned failure/cancellation finalization as a distinct operation. Do not add a second lease scheduler or replace command reconciliation.

Keep writes sequential within one owner. Add a checkpoint revision only if an actual same-owner concurrent write path remains. Do not add revisions solely for hypothetical concurrency.

Provide a database migration and update all callers together. During deployment, stop old workers before enabling token-required writes; do not keep a production bypass for tokenless writers. Historical checkpoints remain readable, and resumed execution obtains new ownership before writing.

Database integration tests must cover owner A writing, owner B taking ownership, and owner A attempting both metadata replacement and entry replacement/deletion. Verify that B's data remains unchanged. Also cover a stale first insert, repeated claims, current-owner writes, terminal runs, generation mismatch, and ownership change racing with a write.

### Validate persisted Pi sessions with Zod

`piSessionMetadataSchema` in `apps/runner/src/pi.ts` currently uses an objectness check for `FileEntry`. A value such as `entries: [{}]` can pass validation without satisfying Pi's entry contract.

Define one versioned project checkpoint decoder with Zod. Validate all entry variants the installed Pi SDK can persist, their required fields, session/header structure, unique IDs, and parent references according to the SDK's actual rules. Inspect the installed SDK source and fixtures; do not infer its full format from a single transcript example or assert `FileEntry` without validation.

Validate before accepting a write and again when loading durable data. Preserve immutable snapshots and configured byte limits. Keep normalization of legacy formats in the same module instead of duplicating it across the runner and database store.

Distinguish no checkpoint from an invalid checkpoint. Support the existing inline-entry and separate-entry-row formats through explicit, tested compatibility paths. Unsupported versions or corrupt entries fail with an allowlisted, non-retryable checkpoint error. Never silently start a fresh session after a decoding failure or erase the stored checkpoint.

Tests must cover current round trips, both supported legacy storage formats, missing IDs, duplicate IDs, invalid variants, broken parent references, malformed headers, and unsupported versions. A structurally valid session must also successfully initialize the installed Pi session manager.

### Accepted rate-limiter limitation

The review's fourth finding concerns process-local request counters. Keep `UserRateLimiter` unchanged for this single-server project. Restarting counters is acceptable. This finding requires documentation only, with no shared store, new dependency, or deployment-readiness project.

## Backend simplification requirements

### Runner modules and Temporal workflow branches

Group the `activities.ts` implementation around workspace lifecycle, execution ownership, and agent execution behind the existing activity exports. The owning module handles cleanup ordering and failure propagation so callers do not repeat them. Keep `execution-coordinator.ts` responsible for dispatch, durable command identity, reconciliation, and ambiguous outcomes. Preserve Docker and Freestyle as its existing adapters.

Extract repeated preparation/recovery/finalization branches in `workflows.ts` into named private functions using ordinary Temporal code. Preserve scheduling, retry policies, cancellation scope behavior, durable finalization, and continue-as-new inputs. Verify replay against representative existing histories. If an extraction changes Temporal commands or their order, revise it to preserve replay behavior instead of treating that change as harmless cleanup.

### Database implementation organization

Group private query implementation in `packages/db/src/threads.ts` by admission/submission, events/checkpoints, and workspace/commands. Start with the checkpoint group during the ownership fix. Keep cohesive code together where an extraction would only add forwarding functions.

Keep `ThreadStore` as the transactional interface, extended only as required for ownership and checkpoint validation. Keep row locks, event sequence allocation, unique-index enforcement, and outbox writes inside the operations that enforce those invariants. Private helpers may accept the current transaction; callers must not reconstruct atomicity by chaining public CRUD methods.

File extraction alone is not a LOC reduction. Accept a split when it places an invariant and its implementation together or removes duplicated logic. Avoid an ORM repository framework and one-file-per-query organization.

### Backend HTTP plumbing and tests

Consolidate repeated authentication/security hooks and error responses in backend route registration where duplication exists. Preserve ownership checks, CSRF requirements, validation behavior, error codes, status codes, and rate-limit behavior. Keep Zod and explicit route handlers. Do not introduce `fastify-type-provider-zod` as part of this scope.

Use typed fixture constructors for repeated backend session and persisted-state setup in tests touched by these changes. Preserve invalid-data fixtures needed for decoder tests. Do not replace useful assertions with broad casts, generic JSON fixtures, or tests that merely mirror the new module structure.

## Version and dependency policy

At implementation time, resolve an explicitly published Effect v4 RC and pin its exact version in the lockfile and dependency declarations. Do not select a v3 release or a moving prerelease tag by accident. Record the upstream revision that corresponds to the selected RC.

Add `effect` to `apps/runner` first and to `packages/api` when its server stream migrates. Use the same version in both. Keep Effect imports out of browser-facing package exports.

Check the pinned source and tests for queue admission, completion, stream consumption, interruption, and finalization semantics before implementation. Some unversioned website links resolve to v3. This specification describes required behavior; API names must be checked against the selected RC.

Matching upstream source is available as an ignored, read-only checkout at `repos/effect/`. `AGENTS.md` records its release pin and recreation instructions. This is agent reference material, not a tracked subtree or application dependency. Keep it aligned with the release selected for implementation. Add a short project pattern document when working patterns exist; its examples must match the selected release and implemented modules.

## Runner module design

### Composition and interfaces

The process entry point constructs shared dependencies once. Use a small Layer composition to supply the database store/pool and execution coordinator where multiple migrated modules need them. Use the store interface established by the correctness fixes; do not create a parallel Effect version of every store method.

Activity implementations use `Effect.gen` for sequential orchestration. Temporal activity exports remain Promise functions. Capture Temporal activity context at entry and translate cancellation and failures at this adapter. Avoid repeated Effect-to-Promise conversions inside application logic. SDK callback and tool interfaces may require explicit bridges.

Do not create a Layer for each helper, configuration property, or store method. Keep implementation modules within `apps/runner/src`. Extract a module only when it owns behavior that existing callers currently coordinate themselves.

`workflows.ts` must remain replay-safe and free of Effect runtime dependencies. Use the shared plain error-code mapping introduced by the credential-leak fix. Preserve the Temporal failure identity decoder used across serialized activity failures.

### Resource ownership and cancellation

The worker process owns database pools, the Temporal connection, and the Effect runtime. Acquire resources with release handlers installed immediately, including failures during worker initialization. On shutdown, stop activities before closing their shared dependencies. The dispatcher may reuse this process resource setup without changing delivery semantics.

Each activity owns its advisory-lock connection and heartbeat task. Each Pi attempt owns its session, subscription, ingress queue, and persistence consumer. Each SSE request owns only its reader and response resources.

Replace `withUserWorkspaceLock` internals with scoped connection acquisition and an interruptible lock-acquisition loop. Preserve PostgreSQL advisory locking. Keep connection acquisition and queries bounded. Do not put an indefinite lock wait inside an uninterruptible acquisition region.

Start heartbeats early enough to cover connection and lock waits. Heartbeat or connection failure must stop protected work. Keep the connection error listener installed through unlock/release. Destroy a connection whose lock ownership or unlock outcome is uncertain instead of returning it to the pool.

Supervise Pi execution and persistence explicitly: consumer failure must signal the attempt and abort Pi. Merely forking a child does not establish the required failure propagation. Give the consumer a lifetime that permits the completion sequence below; cancellation of the producer must not accidentally discard queued writes.

Forward interruption to SDK `AbortSignal` or abort methods where supported. An interrupted Promise wrapper does not prove that external work stopped. Do not release a database connection while its query is still using it, and account for resources acquired after cancellation. Bound acquisition and cleanup using existing operation budgets.

Provider timeout and cancellation after dispatch continue through command reconciliation. Preserve unresolved command ownership and workspace generation checks. Local finalizers cannot run after process termination, so recovery still relies on PostgreSQL and Temporal.

### Typed failures

Use a small domain error union for the migrated attempt path, covering persistence failure, ingress overflow, checkpoint limits, execution timeout, and workspace/command failures that need recovery routing. Reuse existing domain facts instead of inventing an error class per function.

Normalize arbitrary SDK and database rejections at their adapters. Keep unexpected defects distinguishable from expected failures. Public error messages use the shared allowlist for existing and new errors; arbitrary causes stay out of durable payloads. Reuse the ownership-lost and invalid-checkpoint classifications introduced by the correctness fixes.

At the Temporal adapter, explicitly translate the Effect exit into existing `ApplicationFailure` types or `CancelledFailure`. Preserve retryability and recovery routing. Do not let Effect's generic Promise rejection wrapper change the serialized Temporal failure type.

## Pi persistence pipeline

### Interface and ordering

Replace `OrderedPiWriter` with one attempt-owned queue and one sequential consumer. Queue entries are a discriminated union of normalized event writes, captured checkpoint writes, and flush barriers. Use Deferred acknowledgments for operations whose callers need commit confirmation.

The interface provides synchronous event admission, awaitable committed writes, a flush barrier, and completion. A queued item is accepted into memory; a successful acknowledgment means its store operation committed. Queue admission alone is never treated as persistence.

Preserve these rules:

- All events and checkpoints share one FIFO order for the attempt.
- Store writes execute sequentially. Ordered output from a concurrent operator does not establish commit order.
- Existing event identities, dedupe keys, generation metadata, and checkpoint byte limits remain unchanged.
- Every queued checkpoint write carries the claimed ownership token and passes the validated checkpoint contract from the correctness phase.
- Capture checkpoint contents at submission time. Later SDK mutations cannot alter a queued snapshot.
- Keep initial, turn-boundary, and final session checkpoints. Do not checkpoint every delta.
- Tool output writes that are currently awaited remain acknowledged only after commit.
- Flush acknowledges every accepted write preceding its barrier. It does not claim that future producer work is finished.

### Admission and memory limits

Pi event subscriptions are synchronous and cannot await backpressure. Use the selected RC's synchronous queue admission operation and inspect its result. Do not fork an offer per callback or create unlimited pending Promise offers.

Bound both queued item count and retained payload bytes, including checkpoints and the active write. Use initial internal limits of 1,024 items and 16 MiB. Reject an oversized item before copying or retaining its payload. Keep these limits injectable in tests; do not add public configuration knobs for this migration.

On admission overflow, record a terminal `PERSISTENCE_OVERFLOW` failure, stop further admission, and abort Pi once. Reject awaitable callers and prevent run completion. Do not silently drop or slide durable events. The previous committed checkpoint remains available for normal Temporal recovery.

### Completion and failure

Successful completion follows this order:

1. Wait for the Pi producer and its tool calls to settle.
2. Stop the event subscription and reject late callback admission.
3. Validate the result and capture the final checkpoint while the session is still available.
4. Enqueue the final checkpoint and a flush barrier through the internal completion path.
5. Await committed writes and consumer completion.
6. Dispose the session and queue, then return the result to the activity.

Only after this sequence may the activity persist its completion checkpoint and call the existing atomic `completeRun` operation. Normal queue completion must drain accepted items. Queue shutdown is cleanup and must not substitute for flushing.

On persistence failure, stop the consumer, retain the first persistence error, abort Pi once, and fail all pending acknowledgments. Later queued operations must not execute. Cleanup errors must not replace that failure.

On cancellation, producer failure, or overflow, stop production and admission first. If the store is healthy, allow accepted writes to settle within the remaining cleanup budget. If persistence fails, fail pending acknowledgments. Do not hang shutdown or report success if the budget expires. Preserve committed data for recovery.

Preserve error precedence: a persistence failure remains authoritative inside the attempt; an unresolved command remains fatal even if Pi produces a final answer. The Temporal adapter continues to recognize an explicit activity cancellation as cancellation. Record secondary cleanup failures through the existing logger.

## Server event stream

Extract a server-only module in `packages/api/src` for a stream of persisted thread events after a cursor. Keep authentication, ownership checks, cursor validation, and the first database read before Fastify commits SSE headers.

Use the same ordered PostgreSQL query for replay and subsequent polling. Emit the first page once, then query after the last emitted sequence. This avoids a separate replay-to-PubSub handoff and its missing-event race. Retain pages of at most 100 events and the existing poll and heartbeat settings.

The response consumes frames sequentially and respects Node socket backpressure. Wait for drain before advancing consumption or fetching another page. Socket close or error interrupts a pending drain wait and removes listeners. Heartbeat comments share the same serialized response writer and do not advance the event cursor.

Tie request interruption and server shutdown to the reader's scope. Preserve active-stream cleanup during server shutdown. A disconnected reader does not interrupt Pi or cancel a run.

On a database failure after headers are sent, log and close the connection as today. The existing client reconnects with its cursor. Do not introduce stream-wide retries, in-memory fanout, a dedicated PostgreSQL connection per reader, or a new SSE parser.

## Implementation sequence

| Phase | Deliverable                                                                                                              | Required deletions or consolidation                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1     | Fix credential leakage with public error codes/messages and targeted log handling                                        | Remove raw-error public formatting and duplicate failure-message mapping                                     |
| 2     | Add checkpoint ownership, migrations, and Zod session validation; organize the checkpoint implementation                 | Remove unfenced checkpoint write paths, objectness-only decoding, and duplicate format handling              |
| 3     | Pin v4 RC and establish minimal runner composition and Temporal exit conversion; replace Pi persistence/session lifetime | Remove `OrderedPiWriter`, promise-tail drain loops, and redundant checkpoint/abort failure state             |
| 4     | Organize runner ownership/lifecycle modules and migrate lock, heartbeat, and process resource cleanup                    | Remove replaced intervals, duplicate abort listeners, and cleanup blocks                                     |
| 5     | Simplify Temporal branches and remaining cohesive database implementation groups                                         | Consolidate repeated branches and queries without moving invariants to callers                               |
| 6     | Migrate the server event Stream and consolidate repeated backend HTTP plumbing                                           | Remove replaced polling/cleanup code and duplicate hooks/error responses; leave the browser client untouched |
| 7     | Verify behavior, record size changes, update backend documentation and agent patterns                                    | Remove unused compatibility code/imports; document the accepted single-server rate-limiter limitation        |

Each phase must leave runnable code. Do not retain both implementations behind a feature flag or ship a wrapper around the old writer as the final result.

## Acceptance and verification

Tests exercise the module interfaces and observable behavior, not Effect's internal implementation. Reuse existing Pi test fixtures and real database/Temporal integration tests. Use TestClock for Effect scheduling; Temporal timers remain tested with Temporal's test environment.

Required behavioral coverage includes:

- Synthetic credential-leak cases across public responses, durable failures, Pi error checkpoint fields, Temporal failures, and diagnostic logs.
- Stale-owner checkpoint insert/update rejection, unchanged entry rows, ownership races, and prevention of stale completion.
- Valid current/legacy checkpoint recovery and explicit rejection of corrupt or unsupported checkpoints with Zod.
- FIFO event/checkpoint commits, tool write acknowledgments, and flush barriers while a write is blocked.
- Final checkpoint persistence before successful completion and rejection of late callback writes.
- First persistence failure, pending waiter failure, exactly one Pi abort, and no later writes.
- Item and byte overflow without dropped events being presented as success or unlimited waiting fibers.
- Captured checkpoints staying unchanged while later SDK events arrive.
- Cancellation during session creation, lock wait, active execution, commit wait, and cleanup.
- Connection loss and unlock failure destroying the connection; no heartbeat, listener, or session leaks.
- Temporal cancellation and failure types preserving existing retry and recovery behavior.
- Replay of representative Temporal histories after branch extraction.
- HTTP authentication, CSRF, ownership, validation, and error contracts after hook consolidation.
- SSE replay and tail order, cursor precedence, simultaneous clients, slow sockets, disconnect during drain, and server shutdown.
- Worker crash recovery, generation checks, and ambiguous-command reconciliation retaining their existing behavior.

Run focused changed-module tests, `bun run check-types`, `bunx oxlint`, and `bunx oxfmt --check`. Run `bun run test:db` and `bun run test:backend` for the final migration. Do not run paid Pi/Freestyle tests as part of this spec's default verification.

### Code size and complexity gate

Record the implementation baseline commit. For each phase, report production lines added and removed across all affected files, including new helpers and database changes. Use `git diff --numstat <baseline> -- apps/runner/src packages/api/src apps/server/src packages/db/src` for the production diff. Report database migrations separately from application code, and report tests, documentation, lockfiles, and reference source separately as well.

Keep correctness fixes and simplification/Effect adoption in separate reviewable commits. Report their LOC changes separately. Ownership checks and proper validation may add necessary code; their size must not conceal unnecessary Effect scaffolding or be counted as a failed simplification.

A smaller original file does not count as a reduction if its logic moved elsewhere. Every new coordination module must identify the old implementation it replaces. Reject duplicate dependency interfaces, generic forwarding modules, and runtime conversions scattered across internal calls.

Target fewer coordination lines across the simplification/Effect scope. Net growth in that scope requires a concrete benefit demonstrated by tests, such as bounded memory or correct cleanup during partial initialization. Reduce incidental scaffolding before accepting that growth. Report the combined production delta honestly, including correctness work. A LOC target must not remove durability checks or compress readable code into fewer lines.

Completion requires all included phases, resolution of the three correctness findings, removal of replaced plumbing, passing behavioral checks, retained Zod validation, and a final size/behavior report. Verify that `apps/web/**`, `packages/api/src/client.ts`, and browser-facing exports remain unchanged. No shared rate-limiter dependency is required. Installing Effect alone is not completion.

## Related findings and sources

The [backend review](backend-review-report.md) is the source for the required credential-leak, checkpoint fencing, and checkpoint validation fixes and the backend simplification requirements. Update its finding statuses with implementation/test evidence when the work completes. The process-local limiter finding is accepted for the single-server deployment. Product expansion such as computer use, private Git, filesystem backups, and the future Nuxt template remains separate work.

The versioned documentation used for this design is:

- [Effect v4 resource scopes](https://effect.website/docs/v4/resource-management/scope/)
- [Effect v4 queue behavior](https://effect.website/docs/v4/concurrency/queue/)
- [Effect v4 stream consumption](https://effect.website/docs/v4/stream/consuming-streams/)
- [Effect v4 stream resource ownership](https://effect.website/docs/v4/stream/resourceful-streams/)
- [Effect v4 stream error handling](https://effect.website/docs/v4/stream/error-handling/)

Release-specific source and tests take precedence when an RC differs from these pages.
