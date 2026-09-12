# Backend Effect patterns

The runner and server event feed use `effect@4.0.0-rc.113`, pinned to upstream commit `d3b837aee836f35d625d55205f7d6e61305fc198`. The read-only source reference is `repos/effect/`. Zod validates external inputs and persisted sessions. Temporal workflows use ordinary TypeScript and import no Effect runtime.

## Activity execution

`activity-scope.ts` owns heartbeat supervision, advisory-lock connections, and the Promise exit bridge. `activities.ts` exports the same Temporal activity names. Preparation and execution use `Effect.gen` to sequence their work, and one adapter converts the exit to a safe Temporal failure.

`RunnerServices` supplies the existing store, pool, and execution coordinator through one `ManagedRuntime`. It does not duplicate their methods with Effect wrappers. The worker entry point acquires the database, runtime, and Temporal connection with immediate finalizers. `Worker.run()` settles before those dependencies close.

Temporal SDK 1.23 creates workflow threads before native worker initialization. Its failure path does not dispose those threads. The entry point captures the SDK workflow-creator resource during initialization and destroys it if native worker creation fails. `worker-startup.test.ts` verifies that a missing namespace exits without a forced process kill. Recheck this narrow SDK workaround when upgrading Temporal.

The heartbeat starts before the first store read. A heartbeat failure interrupts the activity. Lock acquisition uses `pg_try_advisory_lock` with an interruptible delay. An interrupted pool acquisition destroys a connection delivered after cancellation. A lost connection aborts protected work. The error listener remains installed through unlock and release.

Interruption of a Promise does not prove that remote work stopped. The lock scope waits up to ten seconds for protected work to settle. Uncertain lock state or expired cleanup destroys the connection. Durable command reconciliation and generation checks still decide whether another operation can run.

## Persistence ownership

An activity claims a database-issued token under the existing user workspace lock, after resolving the workspace generation. The token travels with every checkpoint write and attempt-driven completion. PostgreSQL checks ownership inside the mutation transaction. A superseded attempt cannot regain ownership by repeating its claim.

A queue orders writes within one attempt. It does not replace the database ownership check. Workflow-owned cancellation and failure finalization remain separate store operations.

## Failure boundaries

`packages/db/src/public-failure.ts` contains the plain TypeScript allowlist shared by HTTP handlers, activities, and workflows. Unknown failures produce a generic message. The activity adapter constructs a new Temporal failure without SDK causes, response bodies, headers, or details.

Diagnostic logs use selected IDs and stable error codes. Logger redaction handles known structured credential fields; it does not make arbitrary SDK strings safe.

## Event readers

`packages/api/src/server-events.ts` reads committed PostgreSQL events after a sequence cursor. Each reader consumes its initial page once, then polls using the same ordered query with a page limit of 100. A sequential writer waits for socket drain before advancing consumption. Heartbeats use that writer and do not advance the cursor.

Closing a reader interrupts only that reader. It never cancels an execution. A database error after headers closes the stream so the client can reconnect with its last sequence.

## Scheduling tests

Heartbeat, polling, and activity cleanup tests use Effect's `TestClock`. Pi Promise-boundary tests use controlled pending operations and injected cleanup budgets. Database ownership tests use disposable PostgreSQL databases. Temporal workflow tests use the Temporal test environment. Replay fixtures were captured from baseline `0a62b0c17f934d0f4b2ea270516e07417b7c1ff2` before workflow branch extraction.
