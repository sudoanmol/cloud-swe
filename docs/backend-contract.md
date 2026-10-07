# Backend contract

## Processes and ownership

| Component                | Responsibility                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `apps/gateway`           | Bun HTTP/WebSocket preview proxy and hosted-browser CDP relay                      |
| `apps/server`            | Fastify host, database pool ownership, authentication construction, shutdown       |
| `packages/api`           | HTTP validation, authorization, admission, snapshots and SSE                       |
| `apps/runner` worker     | Temporal activities, Pi or scripted execution, remote operation coordination       |
| `apps/runner` dispatcher | PostgreSQL outbox delivery to Temporal                                             |
| PostgreSQL               | Threads, messages, attachments, runs, events, checkpoints, and operation ownership |
| Temporal                 | Scheduling, retries, cancellation and idle lifecycle timers                        |
| Docker or Modal          | The thread's Linux filesystem and running processes                                |
| Private Cloudflare R2    | Immutable attachment originals and model image variants                            |

A browser connection never owns a run. Pi runs on backend workers, with remote tools for the sandbox. Model and provider credentials stay outside the sandbox. PostgreSQL polling drives SSE; Redis is not required.

The database store lives in `packages/db/src/threads/`. Submission, queries, runs, checkpoints, workspaces, commands, and outbox delivery each have a scoped module. Shared lock and event helpers preserve transaction boundaries; `index.ts` exports the existing store interface.

## HTTP API

The canonical backend API uses hand-written Fastify routes. The TanStack Start frontend calls these REST and SSE routes directly with Better Auth cookies. React Query owns application data; the web server does not proxy requests or execute model calls.

Route modules live in `packages/api/src/routers/`. `thread.ts` owns thread routes, `attachments.ts` owns attachment routes, `models.ts` owns model-provider routes, and `git-broker.ts` owns GitHub routes and capability transport.

| Method | Path                                           | Result                                                   |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| GET    | `/api/workspace-features`                      | `{ previews, browser }` feature availability             |
| GET    | `/api/threads/:id/workspace/ports`             | `{ ports: [{ port, url }] }`, running Modal only         |
| GET    | `/api/threads/:id/browser`                     | `{ liveViewUrl, owner }`, no browser creation            |
| POST   | `/api/threads/:id/browser/control`             | `{ owner }`; handing back also settles a pending handoff |
| GET    | `/api/threads?limit=50&before=...`             | Owned thread summaries and a pagination cursor           |
| POST   | `/api/threads`                                 | `202 { threadId, runId }`                                |
| POST   | `/api/threads/:id/messages`                    | `202 { threadId, runId }`                                |
| POST   | `/api/attachments`                             | `201` with uploaded attachment metadata                  |
| GET    | `/api/attachments/:id`                         | The owned original file                                  |
| GET    | `/api/attachments/:id/preview`                 | The owned image's model variant, inline                  |
| DELETE | `/api/attachments/:id`                         | `204` for an unused upload                               |
| GET    | `/api/threads/:id`                             | Messages, runs, workspace and latest event cursor        |
| PATCH  | `/api/threads/:id`                             | `204`; sets `{ title }` of 1–80 characters               |
| DELETE | `/api/threads/:id`                             | `204`; hides the thread and queues its deletion          |
| GET    | `/api/threads/:id/events?after=0`              | Ordered replay, then live SSE                            |
| GET    | `/api/threads/:id/questions`                   | `{ requests }` with durable question state               |
| POST   | `/api/threads/:id/questions/:requestId/answer` | The answered request                                     |
| POST   | `/api/threads/:id/runs/:runId/cancel`          | `202 { runId, cancelRequested: true }`                   |
| GET    | `/api/threads/:id/workspace/summary`           | Head, branch-tip base and sandbox commits                |
| GET    | `/api/threads/:id/workspace/diff?mode=...`     | Changed files and a bounded patch                        |
| GET    | `/api/threads/:id/workspace/files`             | Workspace paths, Git-ignored files excluded              |
| GET    | `/api/threads/:id/workspace/file?path=...`     | One text file of at most 1 MiB                           |
| POST   | `/api/threads/:id/workspace/wake`              | `202 { state }`; queues a wake for a paused one          |

Thread discovery returns `{ threads, nextCursor }`, limited to the authenticated user. Summaries include ID, title, timestamps, latest run status, workspace state, repository URL and branch, and the latest diff count (null before one and after a workspace reset). They exclude messages, events, and checkpoints. `limit` defaults to 50 and accepts 1–100. Threads order by `updatedAt`, which only a submitted user message or a run reaching a terminal state advances. The opaque `before` cursor orders those timestamps at millisecond precision, with descending UUIDs breaking ties. An invalid cursor returns `400`.

Rename appends `thread.title.updated`; a generated title that completes later is dropped. Delete refuses an active run or an executing or unknown Git write with `409 THREAD_BUSY`. Otherwise it marks the thread deleted, after which every owner route answers `404`, and queues a `thread.delete` outbox signal. The thread workflow deletes the workspace through the guarded cleanup path, then purges the rows and exits; attachment objects detach to the hourly attachment cleanup.

Every route requires a Better Auth session. Mutations require an allowed `Origin` and `X-CSRF-Protection: 1`. JSON submissions also require `Content-Type: application/json`. CORS alone is not CSRF protection. Cancellation uses the same origin and request-header checks even though it has no JSON body.

Initial submissions accept `{ prompt, clientMessageId, repositoryUrl?, branch?, modelSelection?, attachmentIds? }`. Follow-ups accept `{ prompt, clientMessageId, modelSelection?, attachmentIds? }`. `attachmentIds` preserves upload order. A prompt can be empty only when `attachmentIds` contains at least one ID. Pi mode requires `modelSelection: { provider, model, thinkingLevel }` on every submission. Scripted local runs can omit it. Prompts contain at most 100,000 trimmed characters; message IDs contain 1–255 characters. Thread and run IDs are UUIDs. HTTPS GitHub repository URLs are accepted regardless of visibility, including repository names such as `.github`. With the Git broker configured, clone and fetch use the signed-in user’s GitHub App access. Without it, anonymous public cloning remains available.

The requested branch is an initial checkout target. A follow-up preserves a valid checkout with the matching origin even if Pi switched branches. A rebuilt workspace clones and verifies the requested branch again.

Client message IDs are unique per user. Repeating an identical submission returns its original run, even after completion. The idempotency comparison includes the attachment IDs and their order. Reusing a client message ID for another request returns `409`. Submission commits the run, the message, attachment bindings, the acceptance event, and the outbox record together.

### Attachments

The browser uploads each selected file to `POST /api/attachments` before it submits the prompt. The upload response contains the attachment ID, safe filename, detected MIME type, original size, classification, and model image metadata. The browser then includes the ordered IDs in `attachmentIds`. Prompt submission never starts or waits for an upload.

`POST /api/attachments` accepts one multipart file and no fields. The route streams the request through a bounded temporary file. It supports files up to 25 MiB, two concurrent uploads per user, and 20 upload requests per minute. PostgreSQL reserves storage before the API writes an object. The per-account allowance is 500 MiB, including pending reservations. A message accepts at most 10 files and 50 MiB of original data.

JPEG, PNG, GIF, and WebP signatures classify an upload as an image. All other files use `application/octet-stream`. The API preserves the original and creates a model image with the first animation frame, corrected orientation, a 40-megapixel input limit, maximum 2000-pixel dimensions, WebP quality 90, and a 3 MiB output limit. Corrupt images and processing timeouts fail the upload.

R2 objects are private and immutable. Their keys derive from the attachment ID (`attachments/<id>/original` and `attachments/<id>/model.webp`), so cleanup finds every object an upload wrote, even after a crash or a lost PUT acknowledgment. `GET /api/attachments/:id` checks the owner and streams the original through the API with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. `GET /api/attachments/:id/preview` checks the owner and streams an image's model variant inline with private browser caching; the browser loads it lazily for thumbnails. `DELETE /api/attachments/:id` deletes only uploads that no message uses. An hourly bounded pass removes failed, unused, or stuck-deleting uploads after 24 hours. Row locks prevent cleanup from racing with message binding.

An image submission requires a model whose catalog input includes `image`. A thread that contains an image cannot switch to a text-only model. When attachment storage is not configured, text-only submissions continue to work and attachment submissions return `503`.

Compute admission keeps a global transaction lock, a default five-run global ceiling, and a unique index for one active run per thread. Production compute requires a linked GitHub account from GitHub App user OAuth whose numeric ID is listed in `ALLOWED_GITHUB_ACCOUNT_IDS`; an unset list admits no one. Production boot requires `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The App callback is `{BETTER_AUTH_URL}/api/auth/callback/github`. Local development can use an unverified email account unless `ALLOW_UNVERIFIED_COMPUTE=false`. Authentication errors return `401`, forbidden requests `403`, inaccessible resources `404`, conflicts `409`, and capacity or rate limits `429`.

Automatic request logs record URL paths without query strings, including OAuth callbacks.

## Onboarding and browser sessions

`GET /api/onboarding` returns the database completion flag, GitHub readiness and install URL, and whether a model credential is stored. It is available before completion. The GitHub check uses this App's non-suspended user-visible installations and readable installation repositories. Incomplete pagination, missing configuration and upstream failure are retryable, not proof that access disappeared.

`POST /api/onboarding/complete` requires a session, trusted Origin and CSRF header. It freshly verifies GitHub readiness and rechecks provider credentials while holding the user row lock. It accepts no user-controlled completion flag. Credential deletion takes the existing provider advisory lock before the user row lock; deleting the final provider clears completion in the same transaction. Confirmed loss of every eligible installation/repository also clears completion. These changes refresh Better Auth's session cookie through its HTTP handler.

Better Auth exposes the server-owned `onboardingCompleted` additional field with `input: false`. Its signed session-data cookie has a 60-second cache lifetime; opaque session tokens and database sessions remain authoritative. API authorization explicitly disables cookie caching so revoked sessions cannot authorize requests. The web server gates product routes in the root route's `beforeLoad`: a server function forwards the request cookies to Better Auth's `get-session`, and the route gates redirect on the returned user's `onboardingCompleted` before rendering, so no client-side session or readiness request blocks the first paint. The result is cached for the document, so client navigations do not re-check the session; onboarding completion and repair refresh it explicitly. Completion and its revocation refresh the session-data cookie, so the gate sees the change on the next request. After render, every product page reads the authenticated readiness endpoint in the background; when it confirms lost GitHub access, the backend clears completion and the page moves to the onboarding repair flow. An unreachable auth server shows Retry, not an anonymous landing page.

New Pi submissions check completion inside the submission transaction after idempotency lookup. Replaying an accepted envelope still resolves after eligibility changes. Pi-mode uploads require completion too. Scripted local submissions without a model selection remain available; cancellation, question answers and already-accepted recovery do not depend on onboarding.

## Thread titles

Initial submission schedules independent, best-effort title work. The database atomically claims a previously untitled thread before dispatch, using its persisted first user prompt only. Follow-ups do not schedule titles. Missing credentials, an empty first prompt, saturation, failure or process interruption can permanently leave `New Thread`. There is no backfill or durable retry.

The server uses AI SDK `generateText` with the official DeepSeek adapter, the application-owned `DEEPSEEK_API_KEY`, configured `DEEPSEEK_API_URL` and exact model `deepseek-flash`. Thinking and SDK retries are disabled. Requests use at most 4,000 prompt characters, 128 output tokens, a 256 KiB response bound and a ten-second deadline; at most two model requests run concurrently. Titles are sanitized and bounded to 80 characters. No user credential or Gateway fallback is used. Shutdown aborts and drains title work before closing the database pool.

Title persistence and `thread.title.updated { title }` commit atomically under the thread lock, even after a run is terminal. Existing titles are never overwritten.

## Events and attempts

Every durable event has a per-thread integer sequence allocated under the thread row lock. SSE encodes that sequence in `id`, the project event type in `event`, and JSON in `data`. The internal event UUID is not the reconnect cursor.

`after` takes precedence over `Last-Event-ID`. Route validation converts the cursor to a number once. Thread ownership is checked when a stream opens, not on every poll. Reconnects can repeat events, so consumers deduplicate by thread and sequence. Heartbeat comments are not durable events. Slow sockets apply backpressure, and disconnecting only closes that reader.

Reader registration and disconnect/shutdown handlers exist before thread authorization or the first event query. No SSE headers are committed after disconnect or shutdown. Authorization and initial-query failures release the reader. Each process allows at most five readers per user and 100 overall, including initializing readers; excess connections receive `429 SSE_LIMIT`.

Snapshots contain persisted messages, ordered public attachment metadata, and run and workspace state. They do not contain attachment bytes, object keys, partial assistant responses, or tool output. A new consumer must replay from zero to reconstruct those events. A reconnecting consumer uses its own cursor instead of skipping directly to a snapshot's latest cursor.

Pi assistant and tool events include `runId` and `attemptId`. New assistant events also carry `assistantAttempt` and `messageIndex`; `assistant.message` closes a message boundary. `assistant.reasoning.delta` streams readable model reasoning for the same message identity. The runner coalesces consecutive provider deltas of one kind for one message and writes them after at most 100 ms or 4,096 characters, and before any other event from the session, so a reader concatenates the same text from fewer events. Text buffered when a run stops is written before persistence closes; and `assistant.message` carries the bounded final `reasoning` (with `reasoningTruncated`) when the model produced any. Provider reasoning signatures stay in checkpoints and never enter events. Consumers accept old events without message indexes, splitting contiguous legacy text around tools. The scripted runner's older numeric deltas and single-shell events are validated separately and normalized into the same projection; malformed Pi identities are still rejected. Assistant identity includes run, opaque attempt, assistant attempt and message index; tool identity includes run, attempt and call ID. Arrival sequence, not lexicographic attempt IDs, establishes replacement. Completed commentary and settled tool results survive continuation; superseded incomplete material does not merge into a later attempt. Persisted assistant messages reconcile by `message.runId`, replacing only the final streamed response.

One SSE reader follows the active thread, even when idle. Its projection cursor starts at zero or resumes from its own last applied sequence. Snapshot cursors are summary watermarks, not replay starting points. Older replay cannot regress a newer snapshot's terminal state, title or workspace generation. Duplicate events are ignored; gaps reconnect from the last applied cursor. Malformed known payloads stop with a protocol error, while unknown future names produce unsupported-event markers. Disconnect, navigation and offline recovery never cancel a run.

An attempt-owned Effect queue serializes Pi events and turn checkpoints. Its first persistence failure aborts Pi, rejects later writes, and is returned to the activity. A terminal run rejects new events and checkpoints. Attempt event writes, checkpoint writes, and attempt-driven completion also require the current database-issued execution token. Superseded attempts cannot replace metadata or entry rows. Final run state, final assistant message, and terminal event commit together.

One Effect scope owns the Pi session, subscription, and writer. Accepted writes drain before success; persistence failure stops the attempt. Session acquisition, prompt execution, abort, and disposal retain bounded waits and late-acquisition cleanup.

Nonzero guest exit codes are tool results. Output events preserve bounded stdout, stderr, exit status and truncation diagnostics. Transport failures, cancellation and timeouts are not ordinary nonzero command results.

Only `bash` opts into live command output. While its admitted fenced command runs, the execution coordinator observes bounded guest-journal capture files through read-only provider calls, initially every 500 ms. Reads validate command ownership metadata and refuse symlink substitution. They are not another workspace mutation. Incremental `tool.output` records carry call/command identity, stream, byte offset, next offset and decoded text through the attempt-owned persistence writer. Text may be empty when a byte range ends inside a UTF-8 character. Stdout and stderr ordering is independent. Final reconciled output replaces the preview.

Observation failure disables live progress with a bounded diagnostic; it cannot settle or release the command. Persistence failure remains fatal and uses the existing reconciliation path. Observation stops before terminal output. Nothing streams through Temporal or directly from a sandbox to the browser.

## Remote operation ownership

The runner holds a PostgreSQL thread workspace advisory lock for lifecycle serialization. That lock alone cannot stop a command after a worker crash. The execution coordinator also records commands durably and uses a guest-side lock and per-command status records.

Each operation identifies its command, run, attempt, database-issued ownership token, workspace, and filesystem generation. PostgreSQL queues at most 36 outstanding operations per generation. Admission allows four concurrent `read` calls from the same owner. Only the validated read tool receives shared access; arbitrary shell commands, edits, writes, repository setup, and resource discovery are exclusive. An exclusive waiter blocks later reads from bypassing it.

A PostgreSQL exclusion constraint prevents overlapping exclusive operations and duplicate read slots. The guest takes a shared workspace lock for reads, an exclusive workspace lock for other commands, and a separate per-command journal lock. Background guest processes can still change files; these locks coordinate runner-dispatched commands.

A retry reconciles every dispatched unsettled operation before replacing ownership. Undispatched queued operations are retired when ownership changes. Unknown outcomes, including reads, block new admission and lifecycle operations until reconciliation or confirmed quarantine teardown. Legacy operations migrate as exclusive. A guest-known process failure can settle an operation; a lost client connection cannot.

Already-aborted requests and cancelled or superseded queue waiters do not dispatch provider work. Cancellation after dispatch is recorded and reconciled. Pause, cleanup, replacement and subsequent execution must respect unresolved commands. Provider calls have bounded deadlines, but a client-side deadline is not proof that the provider stopped work.

Workspace cleanup uses PostgreSQL, not the workflow's pending queue. A guard locks thread and workspace state, checks queued/running runs and unsettled commands, immediately before provider mutation. The guard holds the thread lock through the provider call. Follow-up submissions lock their thread before global admission, so a slow cleanup does not stall other threads. Cancellation does not acquire the global admission lock. An accepted follow-up blocks cleanup even while its outbox signal is undelivered. Provider deletion or confirmed absence must precede the `workspace.deleted` event and clearing the provider ID. Ambiguous outcomes remain recoverable rather than being reported as deleted.

## Preparation, execution and recovery

Preparation provisions or resumes the provider workspace and initializes the repository. Active execution has a separate time budget. The workflow keeps independent preparation and execution activity deadlines, with a schedule deadline covering retries. Invalid configuration and permanent repository errors do not retry. Replacement preparation and execution remain in the active run cancellation scope. Temporal patches preserve representative histories created before the cancellation and stable failure-code fixes.

Server and runner pools observe errors on both idle and borrowed PostgreSQL connections. A broken connection rejects queries without terminating the process; subsequent pool requests can reconnect. Connection loss still invalidates advisory-lock ownership and requires the existing retry and reconciliation paths.

Named checkpoint keys distinguish `workspace-prepared`, `pi-session`, `pi-completed`, and `scripted-step-N`. Pi checkpoints bind the session to its filesystem generation and attempt. At each turn boundary, the store saves session metadata separately from `agent_checkpoint_entry` rows. Unchanged database entry rows are not rewritten, though the worker still serializes and sends the current entry batch. Loading a checkpoint reconstructs its entries in a consistent database snapshot, including older checkpoints that stored entries inline.

Pi checkpoint version 2 replaces attachment-backed model image bytes with the attachment ID, immutable variant hash, MIME type, and size before the 4 MiB size check and queue admission. Restore checks the thread and user ownership, verifies the metadata and object hash, and rebuilds Pi image blocks. Missing or corrupt objects fail explicitly. Version 1 checkpoints and legacy inline entries remain readable. A shared versioned Zod decoder validates session entries and parent references on write and load. Failed literal edits retain only validated `no-literal-match` or `ambiguous-literal-match` facts and a bounded match count in the resumable transcript. Arbitrary exception text remains sanitized. Corrupt or unsupported checkpoints fail explicitly instead of starting a fresh session.

Modal sandboxes run in the `MODAL_APP_NAME` app under a stable name derived from the workspace, which is unique among running sandboxes. Tags record the workspace, thread, lineage (`cloud-swe.restored-from`), and hard-timeout deadline. The provider operates a sandbox only when its tags match the expected workspace and thread. A running sandbox under the workspace name is authoritative: it continues the stored filesystem when it is the stored sandbox or was restored from it, and otherwise the stored filesystem counts as replaced. A missing database provider ID is recovered by that name. Modal `NOT_FOUND` means missing; other failures do not. The provider ID is persisted before later lifecycle mutations.

Every sandbox uses the VM runtime with exit snapshots enabled, two CPUs, 4,096 MiB, and supervisord as its entrypoint. Pause terminates the sandbox and waits for its exit snapshot. The finished sandbox ID stays the provider ID because its exit snapshot holds the filesystem. The next `ensure` creates a sandbox from that snapshot and reports `restored`: the generation is unchanged, and processes, containers, and browser sessions from the old sandbox are gone. When Modal no longer has the snapshot, `ensure` creates a sandbox from the published image and reports `replaced`. A running sandbox with less remaining lifetime than one run needs is paused and restored before the run. Delete terminates the sandbox and deletes its final exit snapshot; earlier snapshots in the chain expire with Modal's retention. `ensure` returns only after the `docker info` readiness probe passes.

A replacement filesystem receives a new generation and a durable reset event. Repository-backed replacements re-clone before Pi resumes. An older session receives an explicit instruction that uncommitted files and local, unpushed commits may be lost, and that it must inspect `/workspace` before continuing.

Before an agent run, the runner restores all thread attachment originals to `/workspace/.attachments/<attachmentId>/<safe-filename>`. It preserves files that already match their recorded size and SHA-256 hash. Transfers use bounded stdin chunks, a temporary file, hash verification, and an atomic rename through the execution coordinator. The attachment directory contains a `.gitignore` with `*`. In Pi mode, the prompt contains a structured path manifest for the current message. Image bytes are also passed to Pi in the same user message.

Repository promotion uses a runner-owned marker with workspace and repository identity. A completed copy is reusable after a crash before marker removal. Incomplete runner-owned copies can be recovered; mismatched or unowned files are not deleted. Clone timeout, storage limits, free-space checks, credential isolation, and the no-submodule policy remain enforced.

Deletion remains destructive. Conversation checkpoints are not filesystem backups.

## Configuration

Sandbox settings belong to `RunnerConfig`. Provider, model, and thinking level come from each submission and persist in `run.model_selection`, outside Temporal history. Turbo forwards `RUNNER_*`, `MODAL_*`, `GIT_BROKER_*`, `R2_*`, `MODEL_CREDENTIALS_ENCRYPTION_KEY`, `COMPOSIO_API_KEY` to development processes. Worker-wide `PI_*` and model API keys no longer select or authenticate user runs.

| Variable                                  | Default                         |
| ----------------------------------------- | ------------------------------- |
| `ALLOWED_GITHUB_ACCOUNT_IDS`              | unset; admits no GitHub account |
| `R2_ENDPOINT`                             | unset; disables attachments     |
| `R2_ACCESS_KEY_ID`                        | required with `R2_ENDPOINT`     |
| `R2_SECRET_ACCESS_KEY`                    | required with `R2_ENDPOINT`     |
| `R2_BUCKET`                               | required with `R2_ENDPOINT`     |
| `R2_REGION`                               | `auto`                          |
| `COMPOSIO_API_KEY`                        | unset; enables per-user MCP     |
| `MAX_ACTIVE_RUNS`                         | `5`                             |
| `RUNNER_ACTIVITY_CONCURRENCY`             | `10`                            |
| `RUNNER_IDLE_PAUSE_MS`                    | `600000`                        |
| `RUNNER_MAX_RUN_MS`                       | `3600000`                       |
| `RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS` | `420000`                        |
| `RUNNER_REPOSITORY_CLONE_TIMEOUT_MS`      | `240000`, clone only            |
| `RUNNER_PROVIDER_TIMEOUT_MS`              | `30000`                         |
| `RUNNER_COMMAND_RECONCILE_TIMEOUT_MS`     | `30000`                         |
| `RUNNER_ACTIVITY_RETRY_MAX_ATTEMPTS`      | `3`                             |
| `RUNNER_ACTIVITY_RETRY_WINDOW_MS`         | `1900000`                       |
| `RUNNER_COMMAND_OUTPUT_MAX_BYTES`         | `262144`                        |
| `RUNNER_CHECKPOINT_MAX_BYTES`             | `4194304`                       |
| `RUNNER_REPOSITORY_MAX_BYTES`             | `4294967296`                    |
| `RUNNER_REPOSITORY_MIN_FREE_BYTES`        | `2147483648`                    |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`    | required for the Modal provider |
| `MODAL_ENVIRONMENT`                       | the token's default environment |
| `MODAL_APP_NAME`                          | `cloud-swe-workspaces`          |
| `MODAL_IMAGE_NAME`                        | `cloud-swe-workspace`           |
| `MODAL_SANDBOX_LIMIT`                     | `5`, running sandboxes          |
| `MODAL_MAX_RUN_SECONDS`                   | `5400`, sandbox lifetime        |

Startup validates that preparation covers clone, provider startup, reconciliation and cleanup grace, and that the retry window covers all configured preparation attempts; execution has its own schedule deadline. The Modal sandbox lifetime must cover preparation, execution, one minute of grace, and the idle pause delay. The lifetime is Modal's hard sandbox timeout, so Modal stops a sandbox even if the worker disappears or a pause fails. The exit snapshot keeps its files. The provider sets no Modal idle timeout, because model turns and approval waits leave a running sandbox without guest commands.

Workflow scheduling values are captured in workflow input. Changing worker environment values does not rewrite an existing workflow's history or timers. Model selection remains fixed for an accepted run across retries. Follow-ups can select another model. Credential changes apply when Pi resolves authentication for its next model request; they do not retract an already dispatched request. Workflow timing changes require a new workflow or an explicit continue-as-new input update; merely continuing with the old input retains the old settings.

## Single-server request limits

Request counters and upload concurrency counters remain process-local. Restarting the server resets them, and capacity eviction can discard a live rate bucket. This is an accepted limitation of the single-server deployment. PostgreSQL still enforces active-run admission and attachment storage quotas. This release does not add a shared limiter or support multiple API replicas.

## Validation scope

Use `bun run check-types`, `bunx oxlint`, `bunx oxfmt --check`, `bun run test:db`, and `bun run test:backend`. The [README](../README.md#validation) includes the full local suite command. Focused runner tests cover guest operation recovery, persistence failures, repository promotion and lifecycle guards. `bun run test:backend:paid` covers the live Modal lifecycle, including the application's idle pause and restore checked against Modal, plus a Pi run. It is a separately authorized, paid check. Image recipe changes require `uv run infra/modal/build_image.py`, which publishes only after `verify.sh` passes on a cold boot and after a restore; local shell checks do not certify a published image.

## Access and workspace timers

Only allowlisted users run tasks. Production compute requires a linked GitHub account whose numeric ID is in `ALLOWED_GITHUB_ACCOUNT_IDS`; local development can use an unverified email account unless `ALLOW_UNVERIFIED_COMPUTE=false`. Every allowed user gets the same limits.

`run.agent_started_at` records the first agent execution under checkpoint ownership. Retries reuse that timestamp across filesystem generations, so the sixty-minute execution deadline is not restarted. Finalization carries the stable failure code independently of public wording, and `run.failed` stores it. Snapshots and SSE therefore retain the result after reconnect.

Execution defaults to sixty minutes, with a separate seven-minute preparation budget. The Modal sandbox lifetime defaults to ninety minutes and covers preparation, execution, one minute of grace, and the idle period; Modal caps any sandbox at 24 hours. A restore starts a new lifetime from the same filesystem.

A workspace pauses after ten minutes of application idleness. A deferred pause retries after another idle period. A paused workspace is never deleted by the application: the workflow waits for new work. Modal keeps each exit snapshot for 30 days after the pause that created it, so a workspace untouched for longer is rebuilt with the reset notice on its next run. Successful review reads, preview requests, and browser-panel polls count as activity: when the idle timer fires, the workflow asks how long remains until ten minutes after the latest read, measured by PostgreSQL's clock, and waits that long. The wait never extends past two minutes before the sandbox's hard timeout, so the pause runs before Modal stops it. A run waiting for answers or Git approval keeps its workspace awake for one idle period and pauses only if no reply arrives; a deferred pause retries after another idle period. Recovery replacement still reports the filesystem-reset notice.

Compute has no application ledger. Each sandbox's hard lifetime bounds one run, `MODAL_SANDBOX_LIMIT` bounds concurrently running managed sandboxes in the app, and the Modal workspace budget caps monthly spend. Preparation never deletes another workspace to make room. A full app returns `PROVIDER_CAPACITY`.

## Workspace review

The review panel reads the live sandbox. The API server holds Modal credentials only for this and runs `workspace-review-program.ts` by sandbox ID with argv, never a shell. These read-only commands are the one exception to routing guest commands through the execution coordinator, like the bash journal observer. They use `git --no-optional-locks` and a private index with intent-to-add entries, so untracked files appear without staging or hashing them. Hooks, fsmonitor and every configured filter driver are disabled, so opening the panel never runs repository-controlled programs. File reads walk directory descriptors with `O_NOFOLLOW`. Output is bounded in the guest (2 MiB patch, 4 MiB Git metadata, 20,000 paths, 1 MiB files) and again by the API while streaming (16 MiB). Reads require a `running` workspace with no lifecycle transition; a paused one answers `409 WORKSPACE_PAUSED`. Each successful read of a running workspace records `workspace.reviewed_at`, written at most once a minute, which defers the idle pause.

Diffs compare against the merge-base of HEAD and `origin/<branch>`, the tip the single-branch clone started from. `mode=all` includes committed, staged, unstaged and untracked changes; `uncommitted` compares the working tree with HEAD; `commit` diffs one commit from the summary list.

`POST .../workspace/wake` inserts one undelivered `workspace.wake` outbox row for an idle-paused workspace. A paused workspace with an active run returns `409 RUN_ACTIVE`, except during a pending browser handoff. During that handoff, the workflow serves the wake through workspace preparation without answering the question or restarting agent execution, then re-arms the idle pause. A pending wake defers continue-as-new until it is served. The dispatcher signals `wakeWorkspace`; the thread workflow runs one wake attempt under the workspace lock, which restores the sandbox and emits `workspace.running`, then re-arms the idle pause. A lost snapshot records a reset instead; the next run re-clones. The panel wakes once when it opens; a later idle pause keeps loaded results and offers a Wake button. Focusing the composer also requests a wake, so the restore overlaps typing.

The runner counts changes with the same program when a run starts, after each completed `bash`, `edit` or `write` call, and when a wake restores the workspace. The server records the same totals whenever the review panel loads the full diff of a running workspace. It appends a thread-level `diff.updated` (`files`, `additions`, `deletions`) only when the count differs from the latest one, and drops a count read from a replaced filesystem generation. Counts are coalesced and best-effort, and the last one lands before the run completes. The browser keeps the latest count, so it shows while the workspace is paused. An open panel refetches after every completed mutating tool, even when the totals are unchanged.

## Remote file tools and resources

Pi receives `bash`, `read`, `write`, and `edit`, named after Pi's built-in tools; built-ins stay disabled, so these remote implementations are the only ones registered. `bash` accepts an optional `timeout` in seconds: the guest deadline defaults to 120 seconds and is capped at 600. The provider RPC timeout bounds provider calls, not guest commands. File operations execute a project-owned Python program in the guest through the command coordinator. Arguments travel over stdin. Paths must resolve under `/workspace` or the scratch directory `/tmp`. The helpers reject traversal, root-escaping symlinks, special files, binary content, invalid UTF-8, and files larger than one MiB. `read` pages like Pi's built-in tool: a 1-indexed `offset` and optional line `limit` select a window, output stops at 2,000 lines or 50 KB, and a notice names the `offset` to continue from. Tools carry Pi prompt snippets and guidelines, so Pi's generated `<tools>` and `<rules>` sections describe them.

`edit` takes Pi's `edits[]` shape: each `oldText` must be nonempty, match exactly once in the original file, and not overlap another edit. All edits match the original content, so their order does not matter, and any failure leaves the file unchanged. A missing or ambiguous match returns a version-two failure with the failing `editIndex` and match count; the resumable transcript keeps only those validated facts. Other helper validation messages reach the model in the live session. Replacement inputs together must fit one MiB. The helper preserves line endings and permissions, writes a temporary file in the target directory, checks the target again, and atomically replaces it. Its version-one result includes the canonical path, number of applied edits, unified diff, addition/deletion counts, hashes, and `diffTruncated`. The diff is at most 64 KiB and the encoded result fits the actual stdout allowance, including JSON escaping. Stdout receives half of `RUNNER_COMMAND_OUTPUT_MAX_BYTES`; the remainder is reserved for stderr. Reads and shell results deliver their complete bounded content to the model. The separate 4 KiB diagnostic summary does not replace that content. `tool.started` stores bounded edit metadata; `tool.completed` stores the structured result and command diagnostics. The resumable Pi transcript retains its original tool arguments.

Before every Pi attempt, coordinated guest commands capture repository instructions and skills, plus global ones from the guest home: `/root/.agents/AGENTS.md` and `/root/.agents/skills`. The global `AGENTS.md` comes before every repository instruction file, so repository instructions take precedence on conflict. Instruction precedence per directory is `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, then `CLAUDE.MD`. Nested contents carry explicit directory scopes. Discovery is bounded to depth 32, 10,000 relevant entries, 200 resource files, 64 KiB per file, and one MiB of content. Generated directories such as `node_modules`, `.venv`, `dist`, `build`, and `target` are skipped. Irrelevant ordinary files do not consume the entry budget. A captured guest file is transferred in bounded, hash-checked pages. Synchronous Pi getters read only the resulting memory snapshot.

Discovery first captures instruction and ignore files plus candidate paths. The runner applies the existing ignore policy before requesting selected skill contents, so excluded oversized skills are never read. Skills come from `.pi/skills`, then `.agents/skills`, then `/root/.agents/skills`, so a project skill wins a name collision with a global one. `AGENTS.md` files inside the global skills tree are not instructions. The `read` tool can read under `/root/.agents`; `write` and `edit` cannot. Discovery follows root Markdown, `SKILL.md` directory, ignore-file, frontmatter, and validation rules, with deterministic canonical-path and name deduplication. Diagnostics are bounded. The project catalog directs Pi to `read`; explicitly disabled model invocation is respected. `/skill:name` expands from captured content. Native Pi prompt expansion, worker-local resources, and project JavaScript extensions remain disabled. Skill references resolve relative to the skill directory and scripts execute only through remote tools.

`write` reports an explicit created/replaced fact, byte count and bounded preview; an existing empty file is a replacement. Durable write arguments contain a bounded preview, while resumable Pi checkpoints retain the complete arguments. Public edit/write/MCP results use allowlisted structured schemas. Legacy stringified results are validated before rendering, with plain-text fallback for malformed or truncated content.

## Model broker

The supported provider IDs are `vercel-ai-gateway`, `openrouter`, `deepseek`, and `openai-codex`. The first three accept API keys. `openai-codex` uses ChatGPT OAuth through device authorization.

| Method | Path                                                 | Result                                                                     |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/api/model-providers`                               | `{ providers: [{ id, name, authType, connected }] }`                       |
| GET    | `/api/model-providers/:provider/models`              | `{ source: "pi-ai", version: "0.87.1", models }`                           |
| PUT    | `/api/model-providers/:provider/credentials`         | Accepts `{ apiKey }` for either API-key provider; returns `204`            |
| DELETE | `/api/model-providers/:provider/credentials`         | Deletes saved credentials and cancels pending ChatGPT login; returns `204` |
| POST   | `/api/model-providers/openai-codex/device-login`     | Returns `202` with a login `id` and status                                 |
| GET    | `/api/model-providers/openai-codex/device-login/:id` | Returns the initiating user's login status                                 |

These routes use the same session authentication and mutation protections as thread routes. Responses use `Cache-Control: no-store`. Credentials, token responses, and raw OAuth errors are never returned. `connected` reports a saved credential, not an upstream entitlement or validity check. Saving an API key does not send a paid model request to validate it.

Model lists contain every model in the pinned pi-ai provider catalog, including `id`, `name`, `provider`, `reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`, and `thinkingLevels`. These are SDK-supported catalogs, not live account-specific entitlement lists. Catalog changes require updating the pinned Pi packages. The browser treats a catalog as fresh for five minutes. Submit a listed model ID and one of its supported thinking levels. The general levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`; availability depends on the model.

For example, a ChatGPT-backed submission has this shape. Select the actual model and thinking level from the model-list endpoint:

```json
{
  "prompt": "Inspect the repository",
  "clientMessageId": "unique-request-id",
  "modelSelection": {
    "provider": "openai-codex",
    "model": "gpt-5.4",
    "thinkingLevel": "medium"
  }
}
```

Submission rejects unknown models, unsupported thinking levels, and missing provider credentials before reserving compute. The selected provider/model/thinking tuple is part of idempotency identity. Replaying an accepted request returns its original run even if its credential has since been deleted. Old queued Pi runs without a selection fail explicitly; they cannot fall back to a worker key. Pi receives the explicit selection even when restoring an older conversation checkpoint.

Set the same `MODEL_CREDENTIALS_ENCRYPTION_KEY` on the API server and runner. Generate 32 random bytes as 64 hexadecimal characters with `openssl rand -hex 32`. Keep the value in server configuration outside Git. The `model_credential` table stores one AES-256-GCM encrypted value per user and provider, with a fresh nonce and authenticated user/provider identity. The version-one encrypted envelope contains the version byte, 12-byte nonce, 16-byte tag, and ciphertext. Changing or losing the encryption key makes existing credentials unreadable; re-encrypt them with the old key before changing configuration, or have users reconnect. Neither keys nor tokens enter guest files, environment variables, commands, or Temporal payloads.

Pi's `CredentialStore.modify` holds a PostgreSQL advisory transaction lock for the user/provider pair. Login, token refresh, key replacement, and deletion share that lock. pi-ai refreshes expiring ChatGPT tokens inside this operation and persists the replacement before using it. API-key resolution reads the current user's credential on each request and does not use ambient worker keys. Provider error messages and diagnostics are sanitized before Pi checkpoints are saved.

Device-login status is `starting`, `pending`, `authorized`, `failed`, or `expired`. A pending response includes `userCode`, `verificationUri`, `intervalSeconds`, and `expiresAt`. Show the code and link, then poll the status endpoint. The backend owns upstream polling even if the browser disconnects. Repeated starts reuse a pending flow; new attempts are limited to five per minute per user. At most 1,000 flows are retained, each for 16 minutes. Device authorization expires after 15 minutes. Deletion cancels the flow and prevents a late result from restoring credentials. Pending flows are process-local: after a server restart, a status lookup returns `404` and the user must start again. Successfully saved credentials survive restarts.

The implementation uses pi-ai 0.87.1's OpenAI Codex OAuth provider. Its device-code, PKCE exchange, and refresh behavior were checked against [Codex device authorization](https://github.com/openai/codex/blob/c4017a87aacc7558002b7cb510025e967c1d765e/codex-rs/login/src/device_code_auth.rs) and [OpenAI authentication documentation](https://developers.openai.com/codex/auth). Local tests replace upstream auth HTTP responses; live ChatGPT login and paid model calls require separate validation.

## Pi MCP tools

When `COMPOSIO_API_KEY` is unset, Pi registers no MCP server and Tools connection controls are hidden. When configured on both the API server and runner, the API lazily creates one Composio session for the authenticated `user.id`, serialized on that user's database row. The `composio_session` table stores only the user and session IDs. Submissions and the Tools UI ensure the session exists; runs resume it with `composio.use(sessionId, { mcp: true })`. Sessions have no expiration. Composio owns connected-account OAuth and refresh.

The runner adds Pi's built-in MCP extension through inline factories, calls `bindExtensions()`, and registers one HTTP server named `composio` with `direct` exposure. MCP configuration discovery, disk extensions, worker-global resources, codemode, and MCP server logs stay disabled. MCP calls execute on the runner. Composio's GitHub toolkit, built-in `composio_search`, Instant tools, and remote workbench are disabled. GitHub access uses our existing broker, search requires a user-connected toolkit, and workspace commands use our execution coordinator. The transport rejects redirects and never attaches ambient Pi OAuth credentials.

The project API key and `session.mcp.headers` remain in server memory. SDK errors are replaced with safe public failures. Incoming MCP messages redact echoed header values before SDK processing; result hooks replace raw details and structured content with bounded text and supported raster images. Calls map onto project-owned `tool.started`, `tool.output`, and `tool.completed` events. Arguments and result content use the configured output byte limit, and the generic MCP card shows server/tool names, collapsible JSON arguments, text and images, truncation, and errors. No credentials are passed to Temporal, checkpoints, sandbox configuration, guest commands, or logs.

`GET /api/tools?search=&cursor=` returns public catalog fields and connection status, including Firecrawl and Context7 MCP recommendations. `POST /api/tools/connect` accepts a toolkit slug and `/onboarding` or `/settings` as the return destination, then returns a Composio authorize link. Both routes require authentication; connects use the existing CSRF checks. Callback query parameters are never trusted as connection proof: the UI re-reads connection status from the user's saved Composio session. Users can skip Tools during onboarding and reach the same UI in Settings, or connect through `COMPOSIO_MANAGE_CONNECTIONS` in chat. Search requires a connected search toolkit; there is no custom web-search fallback.

## Durable questions

Pi's `ask_questions` tool accepts one to three questions with unique IDs, a short header, question text, and optional two- or three-choice suggestions. Answers may also be free text. The first request in a tool batch stops Pi; later calls in that batch receive persisted skipped results.

PostgreSQL atomically stores the immutable request, Pi checkpoint, and ordered `questions.requested` event under checkpoint ownership. One pending request is allowed per run. The activity returns `awaiting_questions`, and Temporal waits without a question timeout. The workspace stays awake for one idle period; if the answer has not arrived by then, Temporal reconciles commands and pauses it unless recent review, preview, or browser-panel activity defers the pause. An `in-use` deferral carries the remaining grace, capped at the provider hard timeout minus the pause margin. The run remains active for admission and deletion guards. Question waiting and workspace re-preparation do not consume the agent execution deadline.

The answer endpoint requires a nonempty value for every question ID. Identical submissions are idempotent; conflicting answers and answers to cancelled requests return `409`. PostgreSQL atomically stores the answer, `questions.answered` event, and `questions.answer` outbox record. The dispatcher signals only the request ID, and the workflow re-reads the request before resuming the same run and model selection with a labelled answer receipt. This also closes the answer-before-wait race. Cancellation settles pending requests with `questions.cancelled`; browser disconnection does nothing.

`request_browser_handoff({ reason })` publishes a question with `browserHandoff: true` and transfers browser ownership to the user in the checkpoint transaction. The Browser tab and question card can hand it back. Answering, cancelling, or handing back updates the owner and appends `browser.owner_changed` in the same transaction. A handback also commits the answer event and resume outbox record. Opening the Browser tab after an idle pause can wake a pending handoff. If its Kernel session expired, the browser route recreates the user-owned session from its saved profile once the workspace runs. Workspace replacement preserves browser ownership. The agent takes a fresh snapshot after resuming and never requests passwords or one-time codes in chat.

Question state survives worker restarts and workspace replacement. Git approval remains a separate wait and authorization path: answering a question cannot approve a Git write.

## GitHub broker and approvals

The backend owns GitHub credentials, read transport, staged pushes, and approved PR writes. Repository and branch listing also use this broker. See [GitHub broker configuration and API](github-broker.md) for routes, permissions, storage limits, and rollout.

Only remote writes require approval. Private clone/fetch, repository and branch listing, PR reads, and local Git/shell/file work do not. Pi exposes `git_push`, `github_pr_read`, `github_pr_create`, `github_pr_update`, `github_pr_close`, `github_pr_reopen`, `github_pr_comment`, and `github_pr_merge` when the broker is configured for a repository-backed run.

A modifying tool prepares an immutable proposal. PostgreSQL commits the proposal, resumable Pi checkpoint, and ordered `git.approval.requested` event in the same ownership-checked transaction. A batch containing an elevated tool executes sequentially. Calls after a pending proposal receive persisted skipped results. The activity returns `awaiting_approval`, releasing its worker and workspace lock; the run remains active for admission and deletion guards.

Temporal waits for an outbox-delivered decision, cancellation, or the 24-hour expiry. If no decision arrives within one idle period, it reconciles commands and pauses the workspace. Approval wait and workspace re-preparation time do not consume the agent execution deadline. Replacement invalidates undispatched proposals. Cancellation invalidates pending or approved operations that have not been claimed for dispatch.

The decision API checks session ownership, CSRF protection, expiry, generation, and proposal digest. Identical decisions are idempotent; conflicting decisions return `409`. `git.approval.decided` and `git.operation.updated` use the existing per-thread SSE sequence. Browser disconnection does not decide or cancel anything.

On resume, the backend executes the approved stored operation before Pi continues, or supplies an explicit rejected, expired, or invalidated receipt. Dispatched writes are never blindly retried. The broker reconciles refs, PR state, and approved operation markers; unresolved outcomes remain `unknown` and block other writes to that repository. Local work and reads remain available on the resumed run.

Pi retains its base prompt and discovered repository instructions. `getAppendSystemPrompt` adds the remote Linux `/workspace` context, Git tool policy, current provider and generation, repository, observed branch, available tools, and configured limits. Bounded coordinated discovery supplies OS and shell facts; the historical snapshot manifest does not supply runtime facts.

## Previews and browser

`apps/gateway` serves untrusted preview traffic separately from the authenticated API. A thread has a unique 32-character random `preview_slug`. Each listening HTTP port has the stable origin `https://{port}-{slug}.<PREVIEW_DOMAIN>`. The database resolves it only to a running Modal workspace without a lifecycle transition. Requests to paused workspaces return 503 and never wake them.

Previews are public. Possession of the slug grants access; there is no application-session requirement, so SSR and server-to-server API requests work. The gateway adds `Referrer-Policy: no-referrer` unless the app sets its own policy. Keep application cookies host-only and preview traffic on a separate site where possible. A shared parent domain is suitable only for the personal deployment that accepts same-site cookie risks. Preview slugs and relay capabilities must not appear in public logs.

Modal changes Host and cannot reach loopback-only servers. The gateway therefore connects to the image's port-7999 forwarder, which restores the preview Host and visitor Authorization before reaching the requested port on IPv4 or IPv6 loopback. The forwarder probes the loopback address before streaming an HTTP body, so IPv6-only listeners accept mutations without request replay. HTTP bodies and SSE stream, redirects pass through, and WebSocket subprotocols survive both hops. Port 7999 cannot itself be previewed. Tokens are cached for ten minutes per sandbox. An upstream authentication rejection re-mints the token; only GET and HEAD are retried because a mutation body cannot be replayed safely. Application authentication failures are marked by the forwarder and do not rotate Modal tokens.

The port list reads `/proc/net/tcp` and `/proc/net/tcp6` through the read-only review program. The agent receives `PREVIEW_URL_TEMPLATE` and Vite's additional allowed-hosts setting. Monorepo frontends must use each service's public origin for API URLs, CORS, and authentication callbacks. These origins remain stable after pause/resume, but servers must restart.

When the browser environment group is configured, Kernel provides one named browser and persistent profile per thread, `cloud-swe-<threadId>`. The provider name resolves the current browser, so no provider session ID is stored in PostgreSQL. `thread.browser_owner` stores durable ownership. Thread deletion removes both the provider browser and profile. Kernel idle timeout matches the runner idle grace within the provider's 10-second to 72-hour limits. Active live-view or CDP connections count as provider activity. The relay closes when the workspace stops or its capability expires.

The runner writes a mode-0600 agent-browser user config through coordinated execution. Its HMAC capability contains thread ID, workspace generation, and sandbox expiry. Only the gateway receives Kernel CDP URLs. Only authenticated thread owners receive live-view URLs. Ownership is polled every second; user ownership or a failed ownership lookup blocks agent CDP commands. A pause, transition, generation change, or expiry revokes an existing connection at the next poll.

`browser.activity_started` and `browser.activity_stopped` have empty payloads and mark command bursts separated by ten seconds of quiet. `browser.owner_changed` carries `{ owner: "agent" | "user" }`. The web projection replays these events for the green dot and control state. The live view starts read-only; `KERNEL_SET_READ_ONLY` toggles interactivity. Its iframe uses an origin-only referrer because Kernel validates parent messages against that origin.

The gateway closes the downstream socket when Kernel disconnects. CDP sessions belong to a connection, so the agent must reconnect and take a fresh snapshot; commands are never replayed automatically. This deliberately avoids pretending that a replacement socket preserves in-flight CDP sessions.

Unset `PREVIEW_DOMAIN` disables previews. Unset all three of `KERNEL_API_KEY`, `BROWSER_RELAY_URL`, and `BROWSER_RELAY_SECRET` to disable hosted browsers. Partial browser configuration fails startup. Disabled features have no provider calls or prompt guidance, and the UI hides their controls. The browser routes are absent when disabled. See [local setup](local-backend.md#enable-previews-and-the-hosted-browser) for gateway deployment.
