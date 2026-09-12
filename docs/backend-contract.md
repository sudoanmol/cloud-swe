# Backend contract

## Processes and ownership

| Component                | Responsibility                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `apps/server`            | Fastify host, database pool ownership, authentication construction, shutdown          |
| `packages/api`           | HTTP validation, authorization, admission, snapshots and SSE                          |
| `apps/runner` worker     | Temporal activities, Pi or scripted execution, remote operation coordination          |
| `apps/runner` dispatcher | PostgreSQL outbox delivery to Temporal                                                |
| PostgreSQL               | Threads, messages, runs, ordered events, checkpoints, workspace and command ownership |
| Temporal                 | Scheduling, retries, cancellation and idle lifecycle timers                           |
| Docker or Freestyle      | The thread's Linux filesystem and running processes                                   |

A browser connection never owns a run. Pi runs on backend workers, with remote tools for the sandbox. Model and provider credentials stay outside the sandbox. PostgreSQL polling drives SSE; Redis is not required.

## HTTP API

The canonical backend API uses hand-written Fastify routes. The Nuxt frontend calls these REST and SSE routes directly.

| Method | Path                                  | Result                                            |
| ------ | ------------------------------------- | ------------------------------------------------- |
| POST   | `/api/threads`                        | `202 { threadId, runId }`                         |
| POST   | `/api/threads/:id/messages`           | `202 { threadId, runId }`                         |
| GET    | `/api/threads/:id`                    | Messages, runs, workspace and latest event cursor |
| GET    | `/api/threads/:id/events?after=0`     | Ordered replay, then live SSE                     |
| POST   | `/api/threads/:id/runs/:runId/cancel` | `202 { runId, cancelRequested: true }`            |

Every route requires a Better Auth session. Mutations require an allowed `Origin` and `X-CSRF-Protection: 1`. JSON submissions also require `Content-Type: application/json`. CORS alone is not CSRF protection. Cancellation uses the same origin and request-header checks even though it has no JSON body.

Initial submissions accept `{ prompt, clientMessageId, repositoryUrl?, branch? }`. Follow-ups accept only `{ prompt, clientMessageId }`. Prompts contain 1–100,000 trimmed characters; message IDs contain 1–255 characters. Thread and run IDs are UUIDs. Only anonymous HTTPS GitHub repositories are accepted, including repository names such as `.github`. Private Git operations remain deferred.

The requested branch is an initial checkout target. A follow-up preserves a valid checkout with the matching origin even if Pi switched branches. A rebuilt workspace clones and verifies the requested branch again.

Client message IDs are unique per user. Repeating an identical submission returns its original run, even after completion. Reusing its ID for another request returns `409`. Submission commits the run, message link, acceptance event and outbox record together.

Compute admission keeps a global limit and database unique indexes for one active run per thread and user. Public production compute requires a verified email or a GitHub account from GitHub App user OAuth, and applies per-user request limits. Production boot requires `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The App callback is `{BETTER_AUTH_URL}/api/auth/callback/github`. Local development can use an unverified email account unless `ALLOW_UNVERIFIED_COMPUTE=false`. Authentication errors return `401`, forbidden requests `403`, inaccessible resources `404`, conflicts `409`, and capacity or rate limits `429`.

## Events and attempts

Every durable event has a per-thread integer sequence allocated under the thread row lock. SSE encodes that sequence in `id`, the project event type in `event`, and JSON in `data`. The internal event UUID is not the reconnect cursor.

`after` takes precedence over `Last-Event-ID`. Route validation converts the cursor to a number once. Thread ownership is checked when a stream opens, not on every poll. Reconnects can repeat events, so consumers deduplicate by thread and sequence. Heartbeat comments are not durable events. Slow sockets apply backpressure, and disconnecting only closes that reader.

Snapshots contain persisted messages and run/workspace state. They do not materialize partial assistant responses or tool output. A new consumer must replay from zero to reconstruct those events; a reconnecting consumer uses its own cursor rather than skipping directly to a snapshot's latest cursor.

Pi assistant and tool events include `runId` and `attemptId`. Delta indexes and dedupe keys belong to one attempt. A consumer must hide an incomplete earlier attempt when a later `assistant.started` arrives, then use the persisted final assistant message after completion. The Nuxt client consumes the canonical REST and SSE endpoints; partial assistant rendering can be layered on top of the event stream.

An attempt-owned Effect queue serializes Pi events and turn checkpoints. Its first persistence failure aborts Pi, rejects later writes, and is returned to the activity. A terminal run rejects new events and checkpoints. Checkpoint writes and attempt-driven completion also require the current database-issued execution token. Superseded attempts cannot replace metadata or entry rows. Final run state, final assistant message, and terminal event commit together.

Nonzero guest exit codes are tool results. Output events preserve bounded stdout, stderr, exit status and truncation diagnostics. Transport failures, cancellation and timeouts are not ordinary nonzero command results.

## Remote operation ownership

The runner holds a PostgreSQL user workspace advisory lock for lifecycle serialization. That lock alone cannot stop a command after a worker crash. The execution coordinator also records commands durably and uses a guest-side lock and per-command status records.

Each operation identifies its command, run, attempt, workspace and filesystem generation. A retry reconciles unsettled operations before dispatching more work. Ambiguous transport outcomes retain exclusive ownership of the workspace generation and block further commands rather than authorizing another mutation. A guest-known process failure can settle an operation; a lost client connection cannot.

Already-aborted requests do not dispatch provider work. Cancellation after dispatch is recorded and reconciled. Pause, cleanup, replacement and subsequent execution must respect unresolved commands. Provider calls have bounded deadlines, but a client-side deadline is not proof that the provider stopped work.

Workspace cleanup uses PostgreSQL, not the workflow's pending queue. A guard locks thread and workspace state, checks queued/running runs and unsettled commands, immediately before provider mutation. The guard holds the thread lock through the provider call. Follow-up submissions lock their thread before global admission, so a slow cleanup does not stall other threads. Cancellation does not acquire the global admission lock. An accepted follow-up blocks cleanup even while its outbox signal is undelivered. Provider deletion or confirmed absence must precede the `workspace.deleted` event and clearing the provider ID. Ambiguous outcomes remain recoverable rather than being reported as deleted.

## Preparation, execution and recovery

Preparation provisions or resumes the provider workspace and initializes the repository. Active execution has a separate time budget. The workflow keeps independent preparation and execution activity deadlines, with a schedule deadline covering retries. Invalid configuration and permanent repository errors do not retry.

Named checkpoint keys distinguish `workspace-prepared`, `pi-session`, `pi-completed`, and `scripted-step-N`. Pi checkpoints bind the session to its filesystem generation and attempt. At each turn boundary, the store saves session metadata separately from `agent_checkpoint_entry` rows. Unchanged entries are not rewritten. Loading a checkpoint reconstructs its entries in a consistent database snapshot, including older checkpoints that stored entries inline. A shared versioned Zod decoder validates session entries and parent references on write and load. Corrupt or unsupported checkpoints fail explicitly instead of starting a fresh session. Checkpoints have a configured byte limit and fail explicitly rather than growing without bound.

Freestyle resources use a stable managed slug. Missing database provider IDs can be recovered only when provider metadata matches the expected workspace. A provider 404 means missing; other failures do not. The provider ID is persisted before later lifecycle mutations.

A replacement filesystem receives a new generation and a durable reset event. Repository-backed replacements re-clone before Pi resumes. An older session receives an explicit instruction that uncommitted files and local, unpushed commits may be lost, and that it must inspect `/workspace` before continuing.

Repository promotion uses a runner-owned marker with workspace and repository identity. A completed copy is reusable after a crash before marker removal. Incomplete runner-owned copies can be recovered; mismatched or unowned files are not deleted. Clone timeout, storage limits, free-space checks, anonymous Git configuration, and the no-submodule policy remain enforced.

Deletion remains destructive. Conversation checkpoints are not filesystem backups.

## Configuration

Provider and model settings belong to one worker `RunnerConfig`, not to workflow input. Turbo forwards `RUNNER_*`, `FREESTYLE_*`, `PI_*`, and `AI_GATEWAY_API_KEY` to development processes.

| Variable                                  | Default                           |
| ----------------------------------------- | --------------------------------- |
| `RUNNER_IDLE_PAUSE_MS`                    | `30000`                           |
| `RUNNER_CLEANUP_MS`                       | `3600000`, after idle pause       |
| `RUNNER_MAX_RUN_MS`                       | `120000`, active execution only   |
| `RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS` | `420000`                          |
| `RUNNER_REPOSITORY_CLONE_TIMEOUT_MS`      | `240000`, clone only              |
| `RUNNER_PROVIDER_TIMEOUT_MS`              | `30000`                           |
| `RUNNER_COMMAND_RECONCILE_TIMEOUT_MS`     | `30000`                           |
| `RUNNER_ACTIVITY_RETRY_MAX_ATTEMPTS`      | `3`                               |
| `RUNNER_ACTIVITY_RETRY_WINDOW_MS`         | `1500000`                         |
| `RUNNER_COMMAND_OUTPUT_MAX_BYTES`         | `262144`                          |
| `RUNNER_CHECKPOINT_MAX_BYTES`             | `4194304`                         |
| `RUNNER_REPOSITORY_MAX_BYTES`             | `4294967296`                      |
| `RUNNER_REPOSITORY_MIN_FREE_BYTES`        | `2147483648`                      |
| `FREESTYLE_AUTO_DELETE_SECONDS`           | `14400`, paused/stopped retention |
| `FREESTYLE_MAX_RUN_SECONDS`               | `900`, continuous VM runtime      |

Startup validates that preparation covers clone, provider startup, reconciliation and cleanup grace, and that the retry window covers all configured attempts. Freestyle requires positive unused-resource retention and a continuous runtime cap long enough for preparation plus active execution. `autoDeleteSeconds` counts time without running, so it does not cap a running VM. `maxRunSeconds` pauses a continuously running VM even if the worker disappears. Neither setting backs up the filesystem.

Workflow scheduling values are captured in workflow input. Changing worker environment values does not rewrite an existing workflow's history or timers. Provider/model settings take effect when a new activity uses the new worker configuration. Workflow timing changes require a new workflow or an explicit continue-as-new input update; merely continuing with the old input retains the old settings.

## Single-server request limits

Request counters remain process-local. Restarting the server resets them, and capacity eviction can discard a live bucket. This is an accepted limitation of the single-server deployment. PostgreSQL still enforces active-run admission. This release does not add a shared limiter or support multiple API replicas.

## Validation scope

Use `bun run check-types`, `bun run check`, `bun run test:db`, and `bun run test:backend`. Focused runner tests cover guest operation recovery, persistence failures, repository promotion and lifecycle guards. Real Freestyle/Pi execution remains a separately authorized, paid integration check. Snapshot recipe changes require a rebuilt VM and `infra/freestyle/verify.sh`; local shell checks do not certify a published snapshot.
