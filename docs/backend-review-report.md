# Backend review

Reviewed September 10, 2026. Implementation follow-up September 11, 2026. Scope: runner, database, server, API, and their tests. The product target is the persistent cloud coding computer described in `AGENTS.md`; the current implementation scope is narrower, as documented in `backend-contract.md` and `freestyle-sandbox-spec.md`.

## Summary

Keep the architecture. PostgreSQL owns durable state, Temporal owns orchestration, Pi runs outside the sandbox, and browser connections only read events. These choices fit the product. Most distributed-systems machinery earns its complexity: deleting command reconciliation, the outbox, generation fencing, or transactional event allocation would remove recovery guarantees.

The adoption implementation addresses checkpoint ownership, persisted-session validation, credential-safe failures, and activity cleanup. The findings below retain the original evidence, followed by their disposition. See the [implementation report](effect-adoption-report.md) for current validation, measured size changes, and deployment requirements.

## Broker integration follow-up, September 12, 2026

The model broker merged first, followed by the GitHub broker. Both route modules now live in `packages/api/src/routers/`. Per-user model credentials, private clone/fetch, and approved pushes and PR writes are implemented. Frontend broker controls and live-provider validation remain separate work.

Integration fixes preserve unresolved Git command failures, reconcile dispatched writes after cancellation, and prevent stale preflight failures from settling another dispatch. A PostgreSQL restart exposed an unhandled error on borrowed connections. Server and runner pools now observe those errors without suppressing query failures. The subprocess regression failed before the fix and passes afterward.

Validation on `main` at `d630ed9` passed all 266 tests across 41 files, including 12 backend recovery tests. `bun run check-types`, `bunx oxlint`, and `bunx oxfmt --check` passed. The approved Vue `shallowRef` change resolves the pre-existing web type-check failure. The [README](../README.md#validation) records the full-suite command. Paid Freestyle/model calls and live GitHub writes were not run.

## Original lint review and validation

- Committed the existing tree first as `5088c97 chore(lint): add anti-slop oxlint plugin`.
- Excluded `apps/web/**` in `.oxlintrc.json`; backend rules remain enabled.
- Replaced loose JSON types and conditional spreads, removed unused declarations, and made error decoding explicit. Added shared JSON types and a tested, cycle-safe failure identity decoder.
- Kept narrow, explained lint exceptions where arbitrary JavaScript failures or external SDK values genuinely enter the system. A lint rule should not make a caught rejection pretend to be a known domain value.
- Final `bunx oxlint`: passed, with no diagnostics.
- TypeScript checks passed for server, runner, API, database, and runner tests.
- Focused runner/API/auth/repository tests: 100 passed.
- Database and failure-decoder tests: 18 passed.
- Temporal thread workflow tests: 4 passed.
- `bun run test:backend`: 11 passed, including worker-crash reconciliation, database/Temporal restart, cancellation, admission, SSE, and workspace rebuilding.

These are local and Docker-backed checks. They do not certify live Freestyle behavior, a published golden snapshot, paid model execution, or the complete computer-use experience. The lint changes remain uncommitted after the requested initial commit. Correctness findings below are review findings, not fixes included in the lint cleanup.

## Correctness findings

### Resolved: error redaction could leave bearer credentials visible

Implementation follow-up: public failures now use the shared allowlist in `packages/db/src/public-failure.ts`. HTTP and Temporal adapters discard raw SDK causes and log selected fields. See `temporal-failure.test.ts`, `packages/api/tests/sse-http.test.ts`, and the checkpoint tests for regression evidence.

Location: `apps/runner/src/pi-writer.ts`, `sanitizeFailureMessage`.

The credential expression consumes only one non-whitespace value. For `Authorization: Bearer DEMO_TOKEN_NOT_A_SECRET`, it replaces `Authorization: Bearer` and leaves the token. This formatter feeds durable errors and checkpoints, so a provider error containing a header can expose credentials to a user or retain them in the database. Cookie headers and quoted values also need more than a one-token expression.

Prefer allowlisted public error messages with a stable error code. Keep diagnostic details in restricted structured logs with logger-level redaction. If string sanitization remains as defense in depth, add tests for bearer/basic authorization, multiple cookies, quoted values, multiline headers, and embedded URLs. Do not claim arbitrary strings can be made secret-free by a regex.

### Resolved: checkpoint writes did not fence stale attempts

Implementation follow-up: migration `0008_checkpoint_ownership.sql` adds database-issued ownership tokens, claim history, and generation ownership. Checkpoint writes and attempt-driven completion validate ownership under the common transaction lock order. The ownership tests cover supersession, stale writes, completion, and races.

Location: `packages/db/src/threads.ts`, `saveCheckpoint`, especially the conflict update around line 742.

The store checks terminal state and workspace generation, but an upsert on `(runId, key)` unconditionally replaces attempt identity and content. A direct store reproduction saved a newer checkpoint, then saved an older attempt in the same generation; the stored result became `old-attempt` with the stale content. Entry rows can likewise be replaced or trimmed.

This proves the persistence interface permits rollback. Whether a particular worker failure reaches this ordering depends on activity overlap and lock ownership; the store itself does not reject it. The per-process ordered writer cannot provide cross-attempt fencing.

Introduce a database-issued execution epoch/ownership token when an attempt takes ownership. Require it on every checkpoint write and check it transactionally. Use a checkpoint revision if writes within an owner can overlap. Do not compare opaque attempt ID strings. Add an integration test where an old owner writes after a new owner and verify both metadata and entry rows remain unchanged.

### Resolved: persisted Pi entries were trusted too early

Implementation follow-up: `packages/db/src/checkpoint.ts` defines the versioned Zod decoder shared by runner and store. It validates installed SDK entry variants, IDs, headers, and references. Unsupported or corrupt data fails with `INVALID_CHECKPOINT`.

Location: `apps/runner/src/pi.ts`, `piSessionMetadataSchema`, around line 559.

`z.custom<FileEntry>` checks only that an entry is a non-null object. A checkpoint containing `entries: [{}]` passes. The generic supplies a TypeScript type without establishing the SDK entry invariants. A malformed or older checkpoint can therefore fail later during recovery rather than at the load interface.

Use a versioned project-owned persisted format with validated entry variants, or a supported SDK decoder with explicit rejection of malformed entries. Test missing IDs, invalid entry types, invalid parent references, and supported older versions. Report an incompatible checkpoint clearly rather than silently starting over and losing conversation state.

### Medium: request quotas are process-local

Disposition: accepted for the single-server project. `UserRateLimiter` remains unchanged. Restart resets and capacity eviction are documented limitations; PostgreSQL retains active-run admission. Shared limiting and multi-server work remain outside this release.

Location: `packages/api/src/routers/thread.ts`, `UserRateLimiter`, around line 127.

Each server has its own map. Restarting resets it; multiple replicas multiply the effective allowance; capacity eviction discards live buckets. Database concurrency admission still protects the active-run limit, so this is not a bypass of that invariant. It is a limitation of the advertised request quota and abuse protection.

This review originally recommended shared limiting before multiple replicas. The adopted scope explicitly accepts process-local request counters for the current single-server deployment. Keep the database admission transaction.

## Fit to the intended product

The implemented lifecycle is a sound foundation: idempotent submissions and an outbox survive API failure; ordered database events support reconnecting readers; workflow timers are independent of browser lifetime; terminal state and final messages commit together; unresolved remote commands block unsafe reuse; replacement filesystems receive a new generation.

Private Git and delivery are now implemented through the [GitHub broker](github-broker.md). Reusable upstream credentials remain outside the VM. The following capabilities remain separate work:

- **Computer use:** a desktop stack in a snapshot does not give Pi screenshot, mouse, keyboard, and window tools. The documented runtime currently exposes shell/read/write. Add a CUA adapter and verify an end-to-end task against a localhost app.
- **Filesystem durability:** conversation checkpoints are not backups of uncommitted files or local commits. VM replacement can re-clone and warn the agent, but cannot restore those changes. Decide what “return to the same computer” promises after cleanup; add external workspace/artifact persistence if preservation is required.
- **Preview and desktop access:** public HTTPS previews and human desktop viewing need explicit authorization and lifecycle handling. Do not expose unauthenticated noVNC, CUA, or debugging endpoints.
- **Golden snapshot verification:** repository-owned setup is the right model. A real VM verification run is still required to establish Docker, desktop, pause/resume, and CUA behavior; local tests are not equivalent.

PostgreSQL polling for SSE is appropriate at demo scale. Redis should remain optional until fanout load justifies it. R2 is useful when adding large artifacts or workspace recovery, not merely because it appears in the target architecture.

## Original simplification recommendations

The adoption implementation consolidates activity scopes, Pi persistence, Temporal recovery branches, and backend HTTP/SSE plumbing. Transactional checkpoint helpers remain in the store so ownership checks and entry mutations share one lock order. The original recommendations below explain the review rationale; they are not a current implementation checklist.

### Runner: concentrate ownership and cleanup

`activities.ts` combines workspace lifecycle, advisory-lock lifetime, heartbeat/cancellation wiring, repository preparation, execution, checkpointing, and finalization. Split implementation by responsibility behind the existing activity interface: workspace lifecycle, execution ownership, and agent execution. Callers should not need to know cleanup ordering.

Keep `execution-coordinator.ts` as a deep module: it should own dispatch, durable command identity, reconciliation, and ambiguous outcomes. Docker and Freestyle are real adapters, so this seam is justified. Avoid adding a second generic orchestration layer above it.

In `workflows.ts`, extract repeated run/recovery/finalization branches into named private functions. Preserve Temporal timers and replay-safe workflow logic. Prefer a small explicit state transition over a generic configurable state-machine framework.

### Database: group invariants, not CRUD methods

`threads.ts` is large because it owns several aggregates. Move private query implementations into admission/submission, event/checkpoint, and workspace/command modules while retaining transactional operations as the interface. Do not expose a collection of generic CRUD helpers that forces callers to reconstruct lock order and invariants.

Keep row locking, unique indexes, event allocation, and outbox insertion together. A shorter function is not an improvement if atomicity moves into caller conventions.

### Server and API: remove repeated HTTP plumbing

The server host is reasonably small; it does not need another application framework. In the API, centralize authentication/security hooks and consistent error responses while retaining explicit route behavior. Schema-driven validation can remove repeated parsing, but only if it also preserves existing error codes and response contracts.

Avoid broad test casts or generic JSON fixtures that erase domain constraints. Use typed fixture constructors for sessions and persisted state. The lint cleanup moves in this direction; further fixture consolidation can reduce repetitive setup.

## Libraries worth considering

| Candidate                   | Manual plumbing it can replace                                                         | Recommendation                                                                                                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eventsource-parser`        | `consumeSse` and incremental frame buffering in `packages/api/src/client.ts`           | Best small replacement. It handles chunked input and provides event/error callbacks and a stream interface. Preserve project JSON validation, cursor rules, reconnection, and bounded buffering. [Official documentation](https://github.com/rexxars/eventsource-parser) |
| `@fastify/rate-limit`       | The custom map/window limiter                                                          | Use its authenticated-user key and a shared store when deploying multiple replicas. It does not replace database compute admission. [Official documentation](https://github.com/fastify/fastify-rate-limit)                                                              |
| `fastify-type-provider-zod` | Repeated route `safeParse` plumbing and separately maintained schema/type declarations | Consider when adding more routes or OpenAPI. Less urgent than the parser and limiter; preserve current validation responses during migration. [Official documentation](https://github.com/turkerdev/fastify-type-provider-zod)                                           |

Keep Drizzle, Zod, Temporal, and the provider SDKs. Do not add an ORM repository framework, another job queue, or a generic retry package alongside Temporal without a specific gap. Libraries cannot establish remote-command safety or checkpoint fencing on the project's behalf.

## Where Effect could help

Effect is most useful inside runner activities, where cancellation, resource lifetime, dependency injection, and typed failures currently interact. It should not replace Temporal, PostgreSQL transactions, or durable command reconciliation.

1. **Scoped resources:** express advisory-lock connections, heartbeat cleanup, abort listeners, and Pi session disposal with acquisition/release in a scope. Effect runs registered finalizers when the scope closes, including failure and interruption. This can concentrate cleanup ordering now spread across `try/finally` blocks. [Scope documentation](https://effect.website/docs/v3/resource-management/scope/)
2. **Typed failures:** represent provider timeout, missing workspace, unknown command outcome, and permanent repository failure as tagged errors. Catch by domain tag inside an activity and translate to Temporal failures once at the activity interface. This can reduce cause-chain inspection; Temporal still serializes failures in its own format.
3. **Cancellation:** wrap asynchronous provider work with an interrupt-aware `AbortSignal`. Interruption must propagate to the SDK where supported. It still does not prove that an already-dispatched remote command stopped; retain reconciliation. [Creating effects](https://effect.website/docs/v3/getting-started/creating-effects/)
4. **Local retry policies:** schedules can express bounded exponential backoff for safe local calls or dispatcher delivery. Do not stack Effect retries on Temporal activity retries without calculating the combined budget. Never automatically retry an ambiguous workspace mutation. [Retry documentation](https://effect.website/docs/v3/error-management/retrying/)

Start with one resource-heavy activity helper, such as `withUserWorkspaceLock`, and compare code size, cleanup tests, and failure behavior before expanding. Keep Promise-based activity exports and run the Effect at that interface. Existing dependency injection is adequate for most tests; introducing Layers everywhere would add ceremony now.

Do not migrate all Zod schemas to Effect Schema, turn every pure function into an Effect, or use Effect Streams merely to avoid a small SSE-parser dependency. Adoption has a learning and maintenance cost. The useful outcome is fewer lifecycle bugs and fewer caller obligations, not uniform syntax.

## Suggested order

1. Replace public raw-error formatting and test credential-leak cases.
2. Add transactional attempt fencing and stale-owner regression tests.
3. Validate and version persisted Pi sessions.
4. Migrate the backend event feed while preserving the browser parser and process-local request limiter. The adoption spec supersedes the broader library suggestions above.
5. Refactor activity ownership/cleanup behind a small interface; evaluate Effect on that slice.
6. Deliver computer-use tools and make the filesystem-retention promise explicit before presenting the full persistent-computer experience.
