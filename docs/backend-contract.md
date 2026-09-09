# Backend contract

## Processes and ownership

| Component                | Responsibility                                                          |
| ------------------------ | ----------------------------------------------------------------------- |
| `apps/server`            | Fastify host construction, CORS, process startup, and shutdown          |
| `packages/api`           | Authentication, HTTP routes, command validation, snapshots, and SSE     |
| `apps/runner` worker     | Temporal workflows, scripted or Pi activities, and sandbox operations   |
| `apps/runner` dispatcher | Retry delivery of the PostgreSQL outbox to Temporal                     |
| PostgreSQL               | Threads, messages, runs, events, checkpoints, workspace records, outbox |
| Temporal                 | Run orchestration, retries, cancellation, idle and cleanup timers       |
| Docker or Freestyle VM   | The thread's development computer                                       |

A thread survives its run, workspace, worker, and browser connection. Token chunks and tool output go to PostgreSQL, not Temporal history. The workflow receives run IDs and reads the prompt in an activity.

## HTTP endpoints

Every thread endpoint requires a Better Auth session. Ownership checks apply to snapshots, streaming, messages, and cancellation.

| Method | Path                                  | Result                                                                      |
| ------ | ------------------------------------- | --------------------------------------------------------------------------- |
| POST   | `/api/threads`                        | Accept initial prompt, return `202 { threadId, runId }`                     |
| POST   | `/api/threads/:id/messages`           | Accept follow-up prompt, return the same response shape                     |
| GET    | `/api/threads/:id`                    | Messages, runs, workspace, and `latestEventId`                              |
| GET    | `/api/threads/:id/events?after=0`     | Ordered SSE replay followed by live polling                                 |
| POST   | `/api/threads/:id/runs/:runId/cancel` | Persist cancellation request, return `202 { runId, cancelRequested: true }` |

Initial prompt submissions accept `{ prompt, clientMessageId, repositoryUrl?, branch? }`. Follow-up submissions accept `{ prompt, clientMessageId }`. Prompts contain 1–100,000 characters after trimming. Message IDs contain 1–255 characters. Thread and run IDs are UUIDs.

`repositoryUrl` accepts only a normalized public HTTPS GitHub URL. `branch` accepts the validated branch-name subset implemented by `normalizePublicGitHubBranch` and requires `repositoryUrl`. The thread snapshot returns nullable repository and branch fields. Follow-ups cannot change either field. Idempotent retries compare both fields with the original request.

Message IDs are unique per authenticated user. Repeating an identical submission returns its original run, including after later runs finish. Reusing the ID for different content, a different thread, or a different submission endpoint returns `409`.

Only one queued or running run is allowed per thread and per user. The global default is two. Capacity errors return `429`; an already-busy user returns `409` when the global limit has not already been reached. Validation errors return `400`, missing authentication returns `401`, and inaccessible thread resources return `404`.

## Events and snapshots

SSE frames contain a per-thread ordered sequence in `id`, a project-owned type in `event`, and JSON in `data`. Event sequences are allocated under a PostgreSQL row lock in the same transaction as their record. The record also has an internal UUID; that UUID is not the SSE cursor.

The `after` query parameter takes precedence over `Last-Event-ID`. Both represent the last event consumed. Event delivery can repeat on reconnect, so clients must deduplicate by thread and sequence. Heartbeat comments are connection keepalives and have no durable ID.

Current event types include `run.queued`, `run.started`, `run.cancel_requested`, `run.completed`, `run.failed`, `run.cancelled`, `workspace.provisioning`, `workspace.running`, `workspace.paused`, `workspace.deleted`, `assistant.started`, `assistant.delta`, `tool.started`, `tool.output`, and `tool.completed`.

The snapshot uses a repeatable-read transaction. It contains persisted messages and current lifecycle state, but does not materialize partial assistant text or tool output. A first-time event consumer must replay from `0` to reconstruct that output. A reconnecting consumer uses its own last consumed cursor. Using a fresh snapshot's `latestEventId` skips earlier transient output events.

PostgreSQL polling currently drives live delivery. Slow sockets wait for backpressure before more events are fetched. Closing a stream stops that reader, and shutting down the API closes its streams. Neither action cancels a run.

## Execution and recovery

Submission atomically writes the message, queued run, acceptance event, and outbox command. The dispatcher retries Temporal delivery and records delivery only after Temporal accepts the signal. Duplicate deliveries target the stable workflow ID `thread:THREAD_ID`; workflow queue deduplication and persisted terminal guards prevent duplicate logical runs.

A scripted run consists of checkpointed steps. Repeated events use stable dedupe keys. The final assistant message, completed run state, and completion event commit together. A durable cancellation accepted before that transaction wins over completion.

Worker activities hold a PostgreSQL advisory lock across the user's workspace lifecycle operations. Before starting a computer on another thread, the runner pauses the user's previous idle running computers. The fixed Docker script also holds a daemon-side file lock, so it remains serialized if the worker dies and PostgreSQL releases its lock.

The script uses a fixed command with prompt bytes on stdin, an execution timeout, and deterministic per-run file paths. Cancellation waits for the bounded fixed command to finish. A worker restart can repeat a script whose effects completed before its checkpoint committed. This repeat is safe for the current script. Arbitrary shell commands will need explicit recovery and fencing policies before Pi tools are connected.

Pi runs initialize `/workspace` after the sandbox is ready and before the first Pi tool call. A public repository is cloned into a runner-owned staging directory with anonymous HTTPS Git, a shallow single-branch checkout, no submodules, and a bounded timeout and disk budget. If a branch was supplied, the runner verifies that branch before promoting the checkout. A non-empty workspace with the wrong origin or branch fails without deleting its files. Repository-backed runs require Pi with Freestyle because the local Docker provider has no network.

An idle workflow pauses its workspace after the grace period, then deletes it after the cleanup period. A follow-up before cleanup resumes the same container. A later message recreates a deleted computer while retaining the PostgreSQL conversation. The workflow continues as new after enough runs or when Temporal recommends it.

## Runner settings

| Variable                             | Default                              |
| ------------------------------------ | ------------------------------------ |
| `TEMPORAL_ADDRESS`                   | `127.0.0.1:7233`                     |
| `TEMPORAL_NAMESPACE`                 | `default`                            |
| `TEMPORAL_TASK_QUEUE`                | `cloud-swe-runner`                   |
| `RUNNER_IDLE_PAUSE_MS`               | `30000`                              |
| `RUNNER_CLEANUP_MS`                  | `3600000`, measured after idle pause |
| `RUNNER_MAX_RUN_MS`                  | `120000`                             |
| `RUNNER_STEP_DELAY_MS`               | `500`                                |
| `RUNNER_ACTIVITY_CONCURRENCY`        | `4`                                  |
| `RUNNER_DOCKER_IMAGE`                | Pinned Ubuntu 24.04 digest           |
| `RUNNER_REPOSITORY_CLONE_TIMEOUT_MS` | `240000`                             |
| `RUNNER_REPOSITORY_MAX_BYTES`        | `4294967296`                         |
| `RUNNER_REPOSITORY_MIN_FREE_BYTES`   | `2147483648`                         |

## Pi and Freestyle boundary

Pi runs on the backend runner. Freestyle provides the Linux VM, filesystem, Docker daemon, browser, and X11 desktop. The current Pi adapter exposes remote shell, read, and write tools. It does not yet expose screenshot, mouse, keyboard, or authenticated preview tools.

Scripted execution remains available for local tests. Its Docker provider has no network, host mounts, Docker socket, or upstream credentials. Repository-backed runs therefore use Pi with Freestyle. Private repository access needs a server-side GitHub App broker. Model, GitHub, Freestyle, and user credentials stay outside the workspace and snapshot.
