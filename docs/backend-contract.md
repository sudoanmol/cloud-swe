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

The database store lives in `packages/db/src/threads/`. Submission, queries, runs, checkpoints, workspaces, commands, and outbox delivery each have a scoped module. Shared lock and event helpers preserve transaction boundaries; `index.ts` exports the existing store interface.

## HTTP API

The canonical backend API uses hand-written Fastify routes. The Nuxt frontend calls these REST and SSE routes directly.

| Method | Path                                  | Result                                            |
| ------ | ------------------------------------- | ------------------------------------------------- |
| GET    | `/api/threads?limit=50&before=...`    | Owned thread summaries and a pagination cursor    |
| POST   | `/api/threads`                        | `202 { threadId, runId }`                         |
| POST   | `/api/threads/:id/messages`           | `202 { threadId, runId }`                         |
| GET    | `/api/threads/:id`                    | Messages, runs, workspace and latest event cursor |
| GET    | `/api/threads/:id/events?after=0`     | Ordered replay, then live SSE                     |
| POST   | `/api/threads/:id/runs/:runId/cancel` | `202 { runId, cancelRequested: true }`            |

Thread discovery returns `{ threads, nextCursor }`, limited to the authenticated user. Summaries include ID, title, timestamps, latest run status, and workspace state. They exclude messages, events, and checkpoints. `limit` defaults to 50 and accepts 1–100. The opaque `before` cursor orders creation timestamps at millisecond precision, with descending UUIDs breaking ties. An invalid cursor returns `400`.

Every route requires a Better Auth session. Mutations require an allowed `Origin` and `X-CSRF-Protection: 1`. JSON submissions also require `Content-Type: application/json`. CORS alone is not CSRF protection. Cancellation uses the same origin and request-header checks even though it has no JSON body.

Initial submissions accept `{ prompt, clientMessageId, repositoryUrl?, branch?, modelSelection? }`. Follow-ups accept `{ prompt, clientMessageId, modelSelection? }`. Pi mode requires `modelSelection: { provider, model, thinkingLevel }` on every submission. Scripted local runs can omit it. Prompts contain 1–100,000 trimmed characters; message IDs contain 1–255 characters. Thread and run IDs are UUIDs. Only anonymous HTTPS GitHub repositories are accepted, including repository names such as `.github`. Private Git operations remain deferred.

The requested branch is an initial checkout target. A follow-up preserves a valid checkout with the matching origin even if Pi switched branches. A rebuilt workspace clones and verifies the requested branch again.

Client message IDs are unique per user. Repeating an identical submission returns its original run, even after completion. Reusing its ID for another request returns `409`. Submission commits the run, message link, acceptance event and outbox record together.

Compute admission keeps a global transaction lock, a default five-run global ceiling, and a unique index for one active run per thread. The admission transaction allows five concurrent owner runs or one run per demo visitor. Public production compute requires a linked GitHub account from GitHub App user OAuth. The owner is identified only by `PRIMARY_GITHUB_ACCOUNT_ID`, matched against the linked numeric GitHub account ID. An unset value grants no owner privileges. Visitors have three lifetime turns including follow-ups and the existing 20 submissions/minute limit. Owners are exempt from both limits. Production boot requires `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The App callback is `{BETTER_AUTH_URL}/api/auth/callback/github`. Local development can use an unverified email account unless `ALLOW_UNVERIFIED_COMPUTE=false`. Authentication errors return `401`, forbidden requests `403`, inaccessible resources `404`, conflicts `409`, and capacity or rate limits `429`.

Automatic request logs record URL paths without query strings, including OAuth callbacks.

## Events and attempts

Every durable event has a per-thread integer sequence allocated under the thread row lock. SSE encodes that sequence in `id`, the project event type in `event`, and JSON in `data`. The internal event UUID is not the reconnect cursor.

`after` takes precedence over `Last-Event-ID`. Route validation converts the cursor to a number once. Thread ownership is checked when a stream opens, not on every poll. Reconnects can repeat events, so consumers deduplicate by thread and sequence. Heartbeat comments are not durable events. Slow sockets apply backpressure, and disconnecting only closes that reader.

Reader registration and disconnect/shutdown handlers exist before thread authorization or the first event query. No SSE headers are committed after disconnect or shutdown. Authorization and initial-query failures release the reader. Each process allows at most five readers per user and 100 overall, including initializing readers; excess connections receive `429 SSE_LIMIT`.

Snapshots contain persisted messages and run/workspace state. They do not materialize partial assistant responses or tool output. A new consumer must replay from zero to reconstruct those events; a reconnecting consumer uses its own cursor rather than skipping directly to a snapshot's latest cursor.

Pi assistant and tool events include `runId` and `attemptId`. Delta indexes and dedupe keys belong to one attempt. A consumer must hide an incomplete earlier attempt when a later `assistant.started` arrives, then use the persisted final assistant message after completion. The Nuxt client consumes the canonical REST and SSE endpoints; partial assistant rendering can be layered on top of the event stream.

An attempt-owned Effect queue serializes Pi events and turn checkpoints. Its first persistence failure aborts Pi, rejects later writes, and is returned to the activity. A terminal run rejects new events and checkpoints. Attempt event writes, checkpoint writes, and attempt-driven completion also require the current database-issued execution token. Superseded attempts cannot replace metadata or entry rows. Final run state, final assistant message, and terminal event commit together.

One Effect scope owns the Pi session, subscription, and writer. Accepted writes drain before success; persistence failure stops the attempt. Session acquisition, prompt execution, abort, and disposal retain bounded waits and late-acquisition cleanup.

Nonzero guest exit codes are tool results. Output events preserve bounded stdout, stderr, exit status and truncation diagnostics. Transport failures, cancellation and timeouts are not ordinary nonzero command results.

## Remote operation ownership

The runner holds a PostgreSQL thread workspace advisory lock for lifecycle serialization. That lock alone cannot stop a command after a worker crash. The execution coordinator also records commands durably and uses a guest-side lock and per-command status records.

Each operation identifies its command, run, attempt, database-issued ownership token, workspace, and filesystem generation. PostgreSQL queues at most 36 outstanding operations per generation. Admission allows four concurrent `remote_read` calls from the same owner. Only the validated read tool receives shared access; arbitrary shell commands, edits, writes, repository setup, and resource discovery are exclusive. An exclusive waiter blocks later reads from bypassing it.

A PostgreSQL exclusion constraint prevents overlapping exclusive operations and duplicate read slots. The guest takes a shared workspace lock for reads, an exclusive workspace lock for other commands, and a separate per-command journal lock. Background guest processes can still change files; these locks coordinate runner-dispatched commands.

A retry reconciles every dispatched unsettled operation before replacing ownership. Undispatched queued operations are retired when ownership changes. Unknown outcomes, including reads, block new admission and lifecycle operations until reconciliation or confirmed quarantine teardown. Legacy operations migrate as exclusive. A guest-known process failure can settle an operation; a lost client connection cannot.

Already-aborted requests and cancelled or superseded queue waiters do not dispatch provider work. Cancellation after dispatch is recorded and reconciled. Pause, cleanup, replacement and subsequent execution must respect unresolved commands. Provider calls have bounded deadlines, but a client-side deadline is not proof that the provider stopped work.

Workspace cleanup uses PostgreSQL, not the workflow's pending queue. A guard locks thread and workspace state, checks queued/running runs and unsettled commands, immediately before provider mutation. The guard holds the thread lock through the provider call. Follow-up submissions lock their thread before global admission, so a slow cleanup does not stall other threads. Cancellation does not acquire the global admission lock. An accepted follow-up blocks cleanup even while its outbox signal is undelivered. Provider deletion or confirmed absence must precede the `workspace.deleted` event and clearing the provider ID. Ambiguous outcomes remain recoverable rather than being reported as deleted.

## Preparation, execution and recovery

Preparation provisions or resumes the provider workspace and initializes the repository. Active execution has a separate time budget. The workflow keeps independent preparation and execution activity deadlines, with a schedule deadline covering retries. Invalid configuration and permanent repository errors do not retry. Replacement preparation and execution remain in the active run cancellation scope. Temporal patches preserve representative histories created before the cancellation and stable failure-code fixes.

Named checkpoint keys distinguish `workspace-prepared`, `pi-session`, `pi-completed`, and `scripted-step-N`. Pi checkpoints bind the session to its filesystem generation and attempt. At each turn boundary, the store saves session metadata separately from `agent_checkpoint_entry` rows. Unchanged database entry rows are not rewritten, though the worker still serializes and sends the current entry batch. Loading a checkpoint reconstructs its entries in a consistent database snapshot, including older checkpoints that stored entries inline. A shared versioned Zod decoder validates session entries and parent references on write and load. Failed literal edits retain only validated `no-literal-match` or `ambiguous-literal-match` facts and a bounded match count in the resumable transcript. Arbitrary exception text remains sanitized. Corrupt or unsupported checkpoints fail explicitly instead of starting a fresh session. Checkpoints have a configured byte limit and fail explicitly rather than growing without bound.

Freestyle resources use a stable managed slug. Missing database provider IDs can be recovered only when provider metadata matches the expected workspace. A provider 404 means missing; other failures do not. The provider ID is persisted before later lifecycle mutations.

A replacement filesystem receives a new generation and a durable reset event. Repository-backed replacements re-clone before Pi resumes. An older session receives an explicit instruction that uncommitted files and local, unpushed commits may be lost, and that it must inspect `/workspace` before continuing.

Repository promotion uses a runner-owned marker with workspace and repository identity. A completed copy is reusable after a crash before marker removal. Incomplete runner-owned copies can be recovered; mismatched or unowned files are not deleted. Clone timeout, storage limits, free-space checks, anonymous Git configuration, and the no-submodule policy remain enforced.

Deletion remains destructive. Conversation checkpoints are not filesystem backups.

## Configuration

Sandbox settings belong to `RunnerConfig`. Provider, model, and thinking level come from each submission and persist in `run.model_selection`, outside Temporal history. Turbo forwards `RUNNER_*`, `FREESTYLE_*`, and `MODEL_CREDENTIALS_ENCRYPTION_KEY` to development processes. Worker-wide `PI_*` and model API keys no longer select or authenticate user runs.

| Variable                                  | Default                           |
| ----------------------------------------- | --------------------------------- |
| `PRIMARY_GITHUB_ACCOUNT_ID`               | unset                             |
| `MAX_ACTIVE_RUNS`                         | `5`                               |
| `RUNNER_ACTIVITY_CONCURRENCY`             | `10`                              |
| `RUNNER_OWNER_MAX_RUN_MS`                 | `3600000`                         |
| `FREESTYLE_OWNER_MAX_RUN_SECONDS`         | `4500`                            |
| `DEMO_MONTHLY_VM_SECONDS`                 | `18000`                           |
| `RUNNER_IDLE_PAUSE_MS`                    | `30000`                           |
| `RUNNER_CLEANUP_MS`                       | `3600000`, after idle pause       |
| `RUNNER_MAX_RUN_MS`                       | `600000`, demo execution only     |
| `RUNNER_WORKSPACE_PREPARATION_TIMEOUT_MS` | `420000`                          |
| `RUNNER_REPOSITORY_CLONE_TIMEOUT_MS`      | `240000`, clone only              |
| `RUNNER_PROVIDER_TIMEOUT_MS`              | `30000`                           |
| `RUNNER_COMMAND_RECONCILE_TIMEOUT_MS`     | `30000`                           |
| `RUNNER_ACTIVITY_RETRY_MAX_ATTEMPTS`      | `3`                               |
| `RUNNER_ACTIVITY_RETRY_WINDOW_MS`         | `1900000`                         |
| `RUNNER_COMMAND_OUTPUT_MAX_BYTES`         | `262144`                          |
| `RUNNER_CHECKPOINT_MAX_BYTES`             | `4194304`                         |
| `RUNNER_REPOSITORY_MAX_BYTES`             | `4294967296`                      |
| `RUNNER_REPOSITORY_MIN_FREE_BYTES`        | `2147483648`                      |
| `FREESTYLE_AUTO_DELETE_SECONDS`           | `14400`, paused/stopped retention |
| `FREESTYLE_MAX_RUN_SECONDS`               | `1200`, demo continuous runtime   |

Startup validates that preparation covers clone, provider startup, reconciliation and cleanup grace, and that the retry window covers all configured attempts. Freestyle requires positive unused-resource retention and a continuous runtime cap long enough for preparation plus active execution. `autoDeleteSeconds` counts time without running, so it does not cap a running VM. `maxRunSeconds` pauses a continuously running VM even if the worker disappears. Neither setting backs up the filesystem.

Workflow scheduling values are captured in workflow input. Changing worker environment values does not rewrite an existing workflow's history or timers. Model selection remains fixed for an accepted run across retries. Follow-ups can select another model. Credential changes apply when Pi resolves authentication for its next model request; they do not retract an already dispatched request. Workflow timing changes require a new workflow or an explicit continue-as-new input update; merely continuing with the old input retains the old settings.

## Single-server request limits

Request counters remain process-local. Restarting the server resets them, and capacity eviction can discard a live bucket. This is an accepted limitation of the single-server deployment. PostgreSQL still enforces active-run admission. This release does not add a shared limiter or support multiple API replicas.

## Validation scope

Use `bun run check-types`, `bun run check`, `bun run test:db`, and `bun run test:backend`. Focused runner tests cover guest operation recovery, persistence failures, repository promotion and lifecycle guards. Real Freestyle/Pi execution remains a separately authorized, paid integration check. Snapshot recipe changes require a rebuilt VM and `infra/freestyle/verify.sh`; local shell checks do not certify a published snapshot.

## Owner and demo policy

Submission reserves one `demo_turn` row per visitor run in the same transaction as its message, run, event, and outbox record. Idempotent retries reuse the run. Migration `0009_demo_policy` backfills completed runs as consumed turns and active runs as reservations. Accounts with three consumed or reserved turns cannot submit another demo turn.

`run.agent_started_at` records the first agent execution under checkpoint ownership. Retries reuse that timestamp across filesystem generations. Completion, the execution deadline, and cancellation after execution begins consume the turn. Infrastructure failures and cancellation before execution release it. Finalization carries the stable failure code independently of public wording. Older workflow histories retain their message-based compatibility path. `run.failed` stores the stable failure code and `turnRestored`. The final transaction adds refund wording to the persisted run error only when it releases the reservation. Snapshots and SSE therefore retain the result after reconnect.

Demo execution defaults to ten minutes, with a separate seven-minute preparation budget. Owner execution defaults to sixty minutes. Freestyle creation and policy reconciliation enforce continuous caps of twenty minutes for demos and seventy-five minutes for owners. Demo reservations also enforce a provider lifetime cap, so restarting a VM cannot reset its reserved budget. Automatic provider restart is disabled. A paused or stopped demo with its current reservation is not restarted automatically.

Both roles pause after thirty seconds of application idleness. Demos are deleted one hour after pausing, with a four-hour provider unused-VM backstop. Owner workflows wait for new work after pausing and skip application deletion. `autoDeleteSeconds: -1` restores the provider's plan retention, currently observed as thirty days without running on Free. It does not promise indefinite filesystem retention. Recovery replacement still reports the filesystem-reset notice.

## Shared demo compute

`packages/db/src/demo-compute.ts` owns the accounting transactions and month allocation policy. `demo_compute_reservation` and `demo_compute_usage` store reservations and usage in PostgreSQL. The default application allowance is 18,000 aggregate VM-seconds per UTC calendar month. Each VM counts independently, including preparation, execution, retries, and idle grace. Owner runs are exempt. The budget excludes model API usage.

Before provider startup, the runner reserves the complete twenty-minute runtime ceiling under a global accounting lock. Existing reservations survive worker restarts. Provider cumulative runtime observations move capacity from reserved to consumed without releasing the unspent reservation. Confirmed pause, stop, or deletion settles usage and releases unused capacity. When a VM is missing and final runtime cannot be recovered, unaccounted capacity stays reserved. An ambiguous create without an observed provider ID also keeps its reservation after a slug lookup returns 404. Absence alone does not prove how much compute was consumed.

Replacement VMs require a separate reservation. Unresolved accounting for the missing VM continues to hold its own capacity. Outstanding capacity carries across month boundaries. The pinned SDK reports cumulative runtime without an authoritative start timestamp. The ledger bounds the start between reservation and observation, then records the runtime guaranteed to fall within each UTC month. `demo_compute_month_allocation` keeps uncertain month attribution reserved in every possible month, including after a VM stops. Uncertainty never becomes silently available capacity. Per-VM consumed totals remain the confirmed provider runtime. This conservative application budget is separate from Freestyle billing.

Preparation checks account inventory, including paused and unrelated VMs. It never deletes another workspace to make room. `FREESTYLE_VM_LIMIT` defaults to five. The small demo VM must report two vCPUs and 4,096 MiB. Five hours at that shape represent ten vCPU-hours and twenty GiB-hours. Capacity and budget failures have separate public codes. Only explicitly allowlisted provider codes identify monthly exhaustion; an arbitrary HTTP 429 does not.

## Remote file tools and resources

Pi receives `remote_exec`, `remote_read`, `remote_write`, and `remote_edit`. File operations execute a project-owned Python program in the guest through the command coordinator. Arguments travel over stdin. The helpers reject traversal, workspace-escaping symlinks, special files, binary content, invalid UTF-8, and files larger than one MiB.

`remote_edit` requires a nonempty literal match and defaults to exactly one occurrence. `replaceAll` replaces non-overlapping occurrences. Replacement inputs together must fit one MiB. The helper preserves line endings and permissions, writes a temporary file in the target directory, checks the target again, and atomically replaces it. Its version-one result includes the canonical path, replacement count, unified diff, addition/deletion counts, hashes, and `diffTruncated`. The diff is at most 64 KiB and the encoded result fits the actual stdout allowance, including JSON escaping. Stdout receives half of `RUNNER_COMMAND_OUTPUT_MAX_BYTES`; the remainder is reserved for stderr. Reads and shell results deliver their complete bounded content to the model. The separate 4 KiB diagnostic summary does not replace that content. `tool.started` stores bounded edit metadata; `tool.completed` stores the structured result and command diagnostics. The resumable Pi transcript retains its original tool arguments.

Before every Pi attempt, coordinated guest commands capture repository instructions and skills. Instruction precedence per directory is `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, then `CLAUDE.MD`. Nested contents carry explicit directory scopes. Discovery is bounded to depth 32, 10,000 relevant entries, 200 resource files, 64 KiB per file, and one MiB of content. Generated directories such as `node_modules`, `.venv`, `dist`, `build`, and `target` are skipped. Irrelevant ordinary files do not consume the entry budget. A captured guest file is transferred in bounded, hash-checked pages. Synchronous Pi getters read only the resulting memory snapshot.

Discovery first captures instruction and ignore files plus candidate paths. The runner applies the existing ignore policy before requesting selected skill contents, so excluded oversized skills are never read. Skills come from `.pi/skills` before `.agents/skills`. Discovery follows root Markdown, `SKILL.md` directory, ignore-file, frontmatter, and validation rules, with deterministic canonical-path and name deduplication. Diagnostics are bounded. The project catalog directs Pi to `remote_read`; explicitly disabled model invocation is respected. `/skill:name` expands from captured content. Native Pi prompt expansion, worker-global resources, and project JavaScript extensions remain disabled. Skill references resolve relative to the skill directory and scripts execute only through remote tools.

The frontend stub and browser-client interfaces are unchanged. Diff rendering and the chatbot template integration remain separate work.

## Model broker

The supported provider IDs are `vercel-ai-gateway`, `openrouter`, and `openai-codex`. The first two accept API keys. `openai-codex` uses ChatGPT OAuth through device authorization.

| Method | Path                                                 | Result                                                                     |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/api/model-providers`                               | `{ providers: [{ id, name, authType, connected }] }`                       |
| GET    | `/api/model-providers/:provider/models`              | `{ source: "pi-ai", version: "0.85.1", models }`                           |
| PUT    | `/api/model-providers/:provider/credentials`         | Accepts `{ apiKey }` for either API-key provider; returns `204`            |
| DELETE | `/api/model-providers/:provider/credentials`         | Deletes saved credentials and cancels pending ChatGPT login; returns `204` |
| POST   | `/api/model-providers/openai-codex/device-login`     | Returns `202` with a login `id` and status                                 |
| GET    | `/api/model-providers/openai-codex/device-login/:id` | Returns the initiating user's login status                                 |

These routes use the same session authentication and mutation protections as thread routes. Responses use `Cache-Control: no-store`. Credentials, token responses, and raw OAuth errors are never returned. `connected` reports a saved credential, not an upstream entitlement or validity check. Saving an API key does not send a paid model request to validate it.

Model lists contain every model in the pinned pi-ai provider catalog, including `id`, `name`, `provider`, `reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`, and `thinkingLevels`. These are SDK-supported catalogs, not live account-specific entitlement lists. Catalog changes require updating the pinned Pi packages. Submit a listed model ID and one of its supported thinking levels. The general levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`; availability depends on the model.

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

The implementation uses pi-ai 0.85.1's OpenAI Codex OAuth provider. Its device-code, PKCE exchange, and refresh behavior were checked against [Codex device authorization](https://github.com/openai/codex/blob/c4017a87aacc7558002b7cb510025e967c1d765e/codex-rs/login/src/device_code_auth.rs) and [OpenAI authentication documentation](https://developers.openai.com/codex/auth). Local tests replace upstream auth HTTP responses; live ChatGPT login and paid model calls require separate validation.
