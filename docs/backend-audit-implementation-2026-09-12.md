# Backend audit implementation — 12 September 2026

This report records the implementation of [the 11 September audit](backend-audit-2026-09-11.md). The audit remains historical evidence. [The backend contract](backend-contract.md) describes current behavior.

## Findings

| Finding                   | Implemented change                                                                                                                                              | Regression evidence                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: parallel tools        | Durable queue of 36 outstanding commands, four shared read slots, exclusive barriers, owner/generation checks, PostgreSQL exclusion constraint, and guest locks | Installed SDK with local model stub, real DB admission and guest execution, bounded queue, exclusive fairness, cancellation/reconciliation, cleanup guards |
| F2: recovery cancellation | Recovery remains in the active cancellation scope; Temporal patch retains old history behavior                                                                  | Cancellation during initial and replacement execution; captured history replay                                                                             |
| F3: model output          | Reads and shell calls return complete bounded output with exit status and truncation metadata                                                                   | Installed SDK's next model request includes a marker beyond 4 KiB                                                                                          |
| F4: SSE initialization    | Reader registration precedes authorization and first event query; disconnect, error, and shutdown release it                                                    | Real HTTP tests during authorization and initial read, plus established-stream tests                                                                       |
| F5: stdout allowance      | Guest capture, structured edits/writes, and resource paging share the actual stdout budget                                                                      | Unicode-heavy edits and resource transfer with a 64 KiB total command budget                                                                               |
| F6: OAuth logging         | Automatic request logs omit query strings                                                                                                                       | Captured automatic logs contain the callback path without synthetic code or state                                                                          |
| F7: migration metadata    | Restored snapshots for 0008/0009 and added 0010 scheduling migration/snapshot                                                                                   | Fresh disposable databases migrate; current schema generates no follow-up DDL                                                                              |
| F8: startup               | README and local guide include a separate dispatcher process                                                                                                    | Documented commands match package scripts; E2E starts server, worker, and dispatcher                                                                       |
| F9: resource exclusion    | Runner applies skill ignore rules before selected content is read; guest skips generated directories                                                            | Ignored oversized skill and a 10,001-file `.venv` do not prevent discovery                                                                                 |
| F10: attempt events       | Event writes require the current database-issued execution token and generation                                                                                 | Superseded attempt event write leaves the event stream unchanged                                                                                           |
| F11: checkpoint failures  | Literal edit failures retain validated reason and match count                                                                                                   | Failed edit survives installed-SDK checkpoint save/load; arbitrary errors remain sanitized                                                                 |

Only the validated read tool receives shared access. Shell commands, edits, writes, repository preparation, and resource discovery remain exclusive. Unknown reads still block mutations and ordinary lifecycle cleanup. Coordinated locks do not freeze files against background guest processes.

## Organization and simplification

`packages/db/src/threads.ts` is replaced by `threads/index.ts` and scoped modules for submission, queries, runs, checkpoints, workspaces, commands, and outbox delivery. `shared.ts` contains transaction locks and event allocation. The `@cloud-swe/db/threads` import and transactional store interface remain available.

Monthly compute transactions now belong to `packages/db/src/demo-compute.ts`. The conservative accounting policy is unchanged. Drizzle returning clauses remove repeated reads; unused helpers, aliases, relations, `outbox.payload`, and the auth package's unused Zod declaration are removed. Zod remains at backend boundaries.

One Effect scope owns the Pi session, subscription, and writer, with a shared timeout/cancellation adapter. Ordered persistence, item and byte bounds, first-failure propagation, accepted-write draining, and late-acquisition cleanup remain. Scripted delays use Node timer promises, and Fastify owns pool shutdown. API admission reads linked-account facts once; finalization carries stable failure codes independently of wording.

The backend now exposes owner-scoped thread discovery with bounded pagination, and caps SSE readers at five per user and 100 per server. Backend CI runs unpaid checks with disposable infrastructure. Browser-facing exports and frontend files are unchanged.

Physical line counts against the starting `HEAD`, including blank lines:

| Scope                                                                           | Before |  After | Difference |
| ------------------------------------------------------------------------------- | -----: | -----: | ---------: |
| All changed production TypeScript/Python sources, including new and moved files | 11,348 | 11,839 |       +491 |
| Pi and Pi persistence, included above                                           |  1,854 |  1,791 |        −63 |
| Thread store and all replacement modules, included above                        |  1,847 |  2,171 |       +324 |
| Migration SQL                                                                   |      0 |     76 |        +76 |
| Migration metadata                                                              |     76 |  5,498 |     +5,422 |

The total production source and SQL change adds 567 lines. The folder split is a navigation improvement, not a claimed deletion. Counts use the union of `git diff --name-only` and `git ls-files --others --exclude-standard`; compare each production file with `git show HEAD:<path>` and count all physical lines. Tests, docs, configuration, the pre-existing audit, and unrelated `.codex/` files are excluded from production counts. Migration metadata is reported separately because most of it restores missing generated snapshots.

## Validation

| Check                                                                                                | Result                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| All unpaid runner, DB, API, auth, and server regressions excluding separately run Temporal/E2E files | 207 passed across 34 files                                                                                  |
| Temporal workflow and captured-history replay tests                                                  | 12 passed                                                                                                   |
| `bun run test:backend`                                                                               | 11 passed, including worker loss, filesystem replacement, service restart, cancellation, and cleanup guards |
| `bun run test:db`                                                                                    | 23 passed; overlaps the broad regression run                                                                |
| Backend and runner-test TypeScript                                                                   | Passed                                                                                                      |
| Root `bun run check-types`                                                                           | Fails with TS2589 at unchanged `apps/web/app/pages/threads/[id].vue:33`                                     |
| Oxlint, Oxfmt, and whitespace checks                                                                 | Passed                                                                                                      |

An initial broad run hit the owner-retention test's default five-second deadline and disrupted teardown. That test now uses the same 30-second deadline as neighboring Temporal scenarios; its rerun passes. Earlier SDK tests were corrected to synchronize actual guest startup and to test read overlap without introducing an artificial barrier behind an exclusive waiter.

Tests use local Postgres, Docker, Temporal, and a local model-response stub. No paid model or Freestyle calls were made. CI configuration was added but has not run on GitHub. Local results do not certify live provider behavior or a golden snapshot.

## Upgrade and retained limits

Migration `0010_audit_command_scheduling.sql` requires `btree_gist` and a coordinated schema/worker upgrade. Legacy operations become exclusive; their durable records remain available for reconciliation. Follow [the migration procedure](local-backend.md#apply-audit-command-scheduling). Only disposable test databases were migrated during this work.

Legacy Temporal activity names and message-based finalization fallback remain for supported histories. The two new workflow patches cover the tested pre-audit histories. Arbitrary older deployment histories still require the existing upgrade procedure.

Private Git, filesystem backups, desktop/CUA integration, broader Effect adoption, multi-server infrastructure, and frontend integration remain deferred as the audit recommends. Existing lint policy remains in place; changing the stylistic rules is a separate tooling choice.
