# Effect adoption implementation report

Baseline: `0a62b0c17f934d0f4b2ea270516e07417b7c1ff2`.

The implementation uses `effect@4.0.0-rc.113`, matching upstream commit `d3b837aee836f35d625d55205f7d6e61305fc198`. Changes remain uncommitted at the user's request. The phase groups below provide review boundaries in place of the specification's proposed separate commits.

## Delivered behavior

1. Public HTTP, Temporal, event, and checkpoint failures use bounded messages from a shared plain TypeScript allowlist. SDK causes and diagnostics cannot bypass that boundary through serialized failures. Checkpoint normalization sanitizes assistant diagnostics and failed tool results.
2. PostgreSQL issues execution ownership tokens and records historical claims. Checkpoint writes and completion check the current token, active run state, and workspace generation under the same transaction lock order. Both initial and recovery workflow branches stop a superseded attempt without finalizing another owner's run.
3. One Zod decoder validates and normalizes persisted Pi sessions at write and load boundaries. It supports the current project envelope and historical inline/separate-row storage with SDK version 3 headers. Unsupported SDK header versions, corrupt entries, duplicate IDs, and broken references fail explicitly. A typed test initializes the installed SDK session manager with decoded entries.
4. An Effect queue, sequential consumer, and Deferred acknowledgments replace `OrderedPiWriter`. The queue includes the active write in its 1,024-item and 16 MiB limits. Attempts capture immutable checkpoints, acknowledge committed writes, stop late callbacks, and drain before successful completion. Failure and cancellation use bounded cleanup.
5. Runner scopes own advisory-lock connections, heartbeats, shared dependencies, and partial initialization cleanup. The worker drains activities before closing dependencies. A narrow Temporal SDK initialization workaround releases workflow threads when native worker creation fails.
6. Named Temporal helpers consolidate preparation, recovery, and finalization branches. Representative pre-adoption success, recovery, failure, and idle histories replay against the new workflow code. Workflows import no Effect runtime.
7. A server-only Effect stream replays and tails PostgreSQL events with sequential socket writes and backpressure. Shared HTTP helpers consolidate security hooks and safe error responses. Browser code, browser-facing exports, and the process-local limiter remain unchanged.

The checkpoint implementation remains inside the transactional store. Private restoration and ownership helpers keep validation and mutation rules together; callers do not compose CRUD operations to reconstruct invariants.

## Replaced coordination code

| New owner                   | Replaced code                                                           | Tested benefit                                                                                               |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `activity-scope.ts`         | Advisory-lock, heartbeat, and activity exit plumbing in `activities.ts` | Interruptible lock waits, connection-loss handling, late acquisition cleanup, bounded protected-work cleanup |
| `pi-persistence.ts`         | Deleted `pi-writer.ts` and promise-tail drain coordination              | FIFO commits, bounded admission, commit barriers, failure propagation, cleanup deadlines                     |
| Pi attempt scope in `pi.ts` | Dispersed session, subscription, and persistence cleanup                | Disposal after setup failure, late callback rejection, final checkpoint before return                        |
| `server-events.ts`          | Polling and response cleanup in the thread router                       | Ordered replay/tail, independent readers, drain backpressure, disconnect and shutdown cleanup                |
| `http.ts`                   | Repeated authentication/security hooks and error responses              | Preserved HTTP contracts with allowlisted failures                                                           |

## Validation

| Check                                                                       | Result                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Database integration and checkpoint decoder                                 | 24 passed, 134 assertions                                  |
| API contracts and SSE                                                       | 35 passed, 113 assertions                                  |
| Pi persistence/lifecycle, SDK compatibility, worker startup/shutdown        | 34 passed, 143 assertions                                  |
| Activity scopes, Temporal failures, workflow behavior, baseline replay      | 30 passed, 83 assertions; includes four captured histories |
| Runner configuration, coordinator, provider, activity, and repository tests | 43 passed, 132 assertions                                  |
| Docker and guest command tests                                              | 9 passed, 57 assertions                                    |
| `bun run test:backend`                                                      | 11 passed, 511 assertions                                  |
| Backend TypeScript and runner-test TypeScript                               | Passed                                                     |
| Full `bunx oxlint`, after review fixes                                      | Passed with no diagnostics                                 |
| Formatting of changed files                                                 | Passed                                                     |

The full `bunx oxfmt --check` also found 54 pre-existing formatting failures in unchanged vendored lint code and installation-skill assets under `tools/oxlint/anti-slop` and `.agents/skills/install-anti-slop`. Those files have no diff from the baseline. Changed test fixtures and decoder tests were formatted; the vendored files remain untouched.

The repository-wide typecheck has a pre-existing frontend error in `apps/web/app/pages/threads/[id].vue:33`: TS2589, excessive type instantiation. The same error was reproduced in a clean detached checkout of the baseline. Backend and runner-test checks are validated separately. Frontend code is outside this change.

Local tests do not certify paid model execution, live Freestyle behavior, or a published golden snapshot. No paid tests were run.

## Size accounting

Production accounting includes all new helpers under `apps/runner/src`, `packages/api/src`, `apps/server/src`, and `packages/db/src`. Migrations are separate. New files are counted with `git diff --no-index --numstat /dev/null <file>` in addition to `git diff --numstat <baseline>`.

Phase attribution uses whole files. Mixed ownership call-site changes in `activities.ts` fall under phase 4; HTTP consolidation in `http.ts` falls under phase 1. These are review groups, not an assertion that every changed line belongs exclusively to one phase.

| Phase / review group                              |     Added | Removed |        Net |
| ------------------------------------------------- | --------: | ------: | ---------: |
| 1: Public failure mapping and HTTP/log boundaries |       174 |       6 |       +168 |
| 2: Checkpoint ownership and Zod decoder           |       559 |      38 |       +521 |
| 3: Pi persistence and session lifetime            |       966 |     334 |       +632 |
| 4: Activity and worker resources                  |       572 |     260 |       +312 |
| 5: Temporal branch consolidation                  |        79 |      77 |         +2 |
| 6: Server event stream and route consolidation    |       168 |      62 |       +106 |
| 7: Verification and documentation                 |         0 |       0 |          0 |
| **Application production total**                  | **2,518** | **777** | **+1,741** |
| Migration and journal, separately                 |        25 |       0 |        +25 |
| **Production including migration**                | **2,543** | **777** | **+1,766** |

The correctness review groups (1–2) add 733 lines and remove 44, a net increase of 689. The Effect and consolidation groups (3–6) add 1,785 and remove 733, a net increase of 1,052. Migration SQL and journal changes add another 25 lines. All new production helpers are included.

| Non-production changes                              |     Added |   Removed |
| --------------------------------------------------- | --------: | --------: |
| Test code                                           |     2,410 |        29 |
| Captured workflow history fixtures                  |     1,754 |         0 |
| Documentation, excluding the supplied specification |       157 |        11 |
| Dependency manifests                                |         2 |         0 |
| Bun lockfile                                        |         4 |         0 |
| Oxlint configuration (`repos/**` exclusion)         |         1 |         0 |
| Ignored upstream Effect reference source            | 0 tracked | 0 tracked |

The user-supplied specification is an untracked 282-line file; its implementation-status update is included in the delivery, but its original design text is not counted as newly authored implementation documentation. Pre-existing user changes to `AGENTS.md` and `.gitignore` are excluded from these totals.

This implementation increases production LOC. It does not claim that moving code into helpers reduced its size. The added coordination supports behavior missing from the original implementation: bounded memory, bounded cleanup, resource release after partial initialization, and safe shutdown ordering. Correctness additions include the full persisted-session decoder and database ownership protocol.

## Deployment

Stop old workers before applying `0008_checkpoint_ownership.sql` and starting token-aware workers. Historical checkpoints remain readable; resumed attempts claim ownership before writing. There is no production bypass for tokenless writers. See [local backend setup](local-backend.md) and [Effect patterns](effect-patterns.md).

Existing stored failure text is outside this forward-write remediation. The process-local rate limiter remains an accepted single-server limitation. Private Git, computer use, filesystem backups, and frontend integration remain separate work.
