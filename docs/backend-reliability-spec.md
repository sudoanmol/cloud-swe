# Backend reliability and simplification spec

Status: proposed for implementation

This document combines the findings from two independent reviews of the backend. It defines the changes needed before the Pi and Freestyle path is treated as reliably recoverable. It does not implement those changes.

The existing architecture remains the basis for this work. PostgreSQL owns durable state and events. Temporal owns lifecycle orchestration. Pi runs on backend workers. Docker and Freestyle provide workspaces. Browser connections remain disposable.

Related documents:

- [Backend contract](backend-contract.md)
- [Freestyle sandbox and public repository spec](freestyle-sandbox-spec.md)
- [Run the backend locally](local-backend.md)

## Outcome

The backend must satisfy these properties:

- A worker crash cannot cause two mutating commands to run in one workspace at the same time.
- A persistence failure stops Pi promptly and remains visible to the activity and workflow.
- Cleanup cannot delete a workspace while PostgreSQL contains an accepted queued or running run.
- Cleanup can find a Freestyle VM when the database does not yet contain its provider ID.
- A replacement VM is identified as a new filesystem, and Pi receives an explicit reset instruction.
- Repository initialization recovers a completed promotion after a crash.
- Clone, provider, command, and agent time limits do not override one another.
- Event ordering, retry behavior, command diagnostics, and checkpoint boundaries are explicit.
- The API has one canonical style, cookie-authenticated mutations have CSRF protection, and compute admission limits abuse and cost.
- Dead compatibility paths and provider-specific names are removed after the safety work lands.

## Decisions to keep

Keep the following decisions from the current design:

- Use PostgreSQL as the durable source for thread state and ordered events.
- Use the outbox and `signalWithStart` with the stable workflow ID `thread:THREAD_ID`.
- Keep Temporal out of high-volume token, tool, and stdout streaming.
- Keep the database-enforced partial unique indexes for one active run per thread and per user.
- Keep the Docker provider's network, capability, process, memory, and host-mount restrictions.
- Keep Pi on backend workers and keep upstream credentials out of workspaces and snapshots.
- Keep PostgreSQL polling for the first low-concurrency demo. Add notification-based wakeups before adding Redis or Valkey fan-out.
- Keep public repository cloning limited to anonymous HTTPS GitHub repositories. Private repository support remains a separate GitHub App and broker project.
- Keep deletion destructive while external workspace persistence is deferred. The product must state when uncommitted files and local, unpushed commits are lost.

Do not replace Temporal, PostgreSQL, or the provider boundary as part of this work. Those changes would not solve the reviewed failure modes.

## Invariants

The implementation must preserve these invariants:

1. A thread is durable independently of its run, workspace, worker, and browser connection.
2. A run is terminal only after its final state and terminal event commit together.
3. A terminal run cannot receive new events or checkpoints.
4. PostgreSQL decides whether a run was accepted, queued, running, or terminal. Temporal's in-memory pending list is only a delivery and scheduling hint.
5. Every remote command has one identifiable owner, one workspace generation, and one recoverable status.
6. A workspace is marked `deleted` only after the provider confirms deletion or confirms that the VM or container is already missing.
7. A workspace replacement never reuses a checkpoint as if it described the replacement filesystem.
8. Every durable event has a per-thread sequence allocated under the thread row lock.

## Workstream 1: fence remote commands

Priority: P1

The PostgreSQL workspace lock protects work while the worker holds its connection. It cannot stop a command that the provider already accepted when the worker crashes. Add a guest-side execution boundary and reconciliation protocol.

### Requirements

- Route every Pi `remote_exec`, `remote_read`, and `remote_write` operation through one provider execution coordinator.
- Give each operation a durable `commandId`, `runId`, activity `attemptId`, workspace identity, and workspace generation.
- Serialize operations inside the guest. The Docker provider must generalize its current `flock` behavior beyond the scripted command. The Freestyle image must provide an equivalent lock or command supervisor.
- Record operation state at least as `pending`, `running`, `completed`, `failed`, or `unknown`.
- Persist enough operation metadata to identify a command after a worker restart. The record may use a new table or a workspace-owned operation record, but it must not exist only in worker memory.
- Do not release the workspace execution lease after an interrupted client request if the guest command may still be running.
- On retry, reconcile the previous `commandId` with the guest and provider before starting another command.
- If reconciliation cannot distinguish completed, failed, and running, quarantine the workspace for that run and fail closed. Do not start a second mutating command.
- Cleanup, pause, replacement, and deletion must wait for command completion or reconciliation before they change the workspace state.
- Keep the existing PostgreSQL user workspace lock for lifecycle serialization. Treat the guest-side boundary as a separate guarantee for worker-crash recovery.

### Cancellation and provider deadlines

- Check an `AbortSignal` before dispatching a provider operation. An already-aborted request must not call `vm.exec()` or start a Docker process.
- Bound every provider API call, including VM creation, start, pause, delete, data lookup, and command execution.
- Remove the Docker provider's fixed 20-second process timer. Derive the outer Docker deadline from the command request timeout and keep the in-guest command timeout aligned with it.
- If cancellation arrives after a command is dispatched, mark the command as cancellation-requested and reconcile it before releasing ownership. Do not abandon the command merely because the client promise was interrupted.
- Make the provider adapter distinguish a completed command, a failed command, a transport timeout, a cancellation, and an unknown provider outcome.
- Preserve provider-side runtime limits as a final cost and cleanup guard. Production Freestyle configuration must use a finite auto-delete or maximum-lifetime value. Local tests may use a disabled provider TTL only when the test cleanup is explicit.

## Workstream 2: separate preparation, execution, and retry budgets

Priority: P1

The current activity uses `RUNNER_MAX_RUN_MS` for workspace preparation and Pi execution. Its default is shorter than the repository clone timeout, so Temporal can terminate the activity before the clone budget is reached.

### Requirements

- Split the current `executeRun` function into separate units with clear ownership:
  - `prepareWorkspace` provisions the provider workspace and initializes the repository.
  - `runPi` runs one Pi attempt and persists its session.
  - `runScripted` runs the local scripted executor.
  - Finalization remains a separate operation.
- Apply `RUNNER_REPOSITORY_CLONE_TIMEOUT_MS` only to repository cloning.
- Add a workspace preparation timeout that covers provider startup, repository initialization, clone cleanup, and a bounded grace period.
- Apply `RUNNER_MAX_RUN_MS` only to active agent execution.
- Configure Temporal `startToCloseTimeout` and `scheduleToCloseTimeout` independently for preparation and execution. The schedule timeout must cover the configured retry window instead of equaling one attempt's timeout.
- Use named checkpoint keys such as `workspace-prepared`, `pi-session`, `pi-completed`, and `scripted-step-N`. Do not use one integer namespace for two execution modes.
- Use `ApplicationFailure.nonRetryable` for invalid configuration, an unsupported provider, a terminal run, invalid stored repository data, and other conditions that a retry cannot change.
- Keep transient database, provider, and worker failures retryable when the command and workspace reconciliation rules make a retry safe.
- Validate `AI_GATEWAY_API_KEY` at runner startup. Remove the duplicate activity-time check.

### Configuration ownership

- Pass one `RunnerConfig` instance to providers and activities. Providers must not read runtime settings directly from the global `env` object.
- Use `config.freestyleSnapshotId`, `config.freestyleIdleTimeoutSeconds`, and `config.freestyleAutoDeleteSeconds` in the Freestyle provider.
- Use the configured Pi provider when setting the runtime API key. Do not hard-code `vercel-ai-gateway` in `pi.ts` while exposing `piProvider` as a setting.
- Configure Pi with an explicit in-memory session, model, tool, skill, and extension set. A worker-local Pi installation must not add tools or configuration to a user run.
- Keep Temporal workflow input limited to values the workflow itself uses, such as lifecycle timing and run scheduling data. Provider, model, and credential settings belong to the worker configuration unless they become explicit durable per-thread settings.
- Document which settings apply to existing workflows and which settings take effect only after continue-as-new or a new workflow.
- Add all Pi, Freestyle, and runner settings used by `bun run dev` to Turbo's `dev.passThroughEnv`, including `RUNNER_EXECUTION_MODE`, `RUNNER_SANDBOX_PROVIDER`, `FREESTYLE_*`, `PI_*`, and `AI_GATEWAY_API_KEY`.

## Workstream 3: make cleanup use database truth

Priority: P1

An accepted follow-up creates a queued run before its outbox signal reaches Temporal. The workflow can still believe that the thread is idle and delete the workspace.

### Requirements

- Before pausing or deleting a workspace, run a database transaction that locks the thread and workspace records and checks for any `queued` or `running` run.
- Serialize that check with message submission and admission. If submission wins, cleanup must see the new queued run. If cleanup wins, the later run must recreate or resume the workspace safely.
- Treat any queued or running run as a reason to skip destructive cleanup. Do not use Temporal's `pending` array as the deciding check.
- Recheck the database immediately before a destructive provider call. The workflow's idle timer is not sufficient.
- Return a distinct deferred result when cleanup found an active run, so the workflow can return to its wait state without marking the workspace deleted.
- Emit `workspace.deleted` and clear `providerId` only after the provider confirms deletion or confirms that the resource is missing.
- If the provider returns an ambiguous result, leave the database state unchanged and retry or mark recovery as required. Do not report a successful deletion.
- Assign a durable lifecycle transition ID when a workspace transition begins. Retries must reuse that ID, while separate pause and resume cycles must receive different IDs. Do not use a new random UUID for every retry of the same transition.

### Admission simplification

- Keep the global transaction advisory lock for the global active-run limit.
- Use the partial unique indexes for the per-user and per-thread invariants. Remove the redundant per-user advisory lock and avoid relying on a second query as the enforcement mechanism.
- Use `count(*)` for the global active-run count.
- Map unique-constraint conflicts to the existing `USER_BUSY` or `THREAD_BUSY` errors when the response needs to distinguish them.
- Create the run before inserting or updating the user message link when the schema permits it. Remove the all-zero UUID sentinel and handle a nullable `runId` directly.

## Workstream 4: recover Freestyle identity and filesystem generations

Priority: P1

Freestyle creation can succeed before the worker writes `providerId`. A later cleanup must be able to find the VM from the stable workspace slug. A missing VM also means that a Pi session may describe files that no longer exist.

### Requirements

- Make Freestyle `pause()` and `delete()` resolve a missing `providerId` by the stable workspace slug.
- Adopt a VM found by slug only when its managed metadata matches the expected workspace. Never adopt an unmanaged VM.
- Preserve the existing create-reconciliation path that looks up a VM by slug after an interrupted create.
- Persist the recovered provider ID before later lifecycle work continues.
- Treat a provider 404 as confirmed missing. Treat other lookup or delete failures as unknown and retry without claiming success.
- Add a workspace generation identifier. Increment it when a workspace is rebuilt after VM deletion or unexpected VM loss.
- Store the generation with Pi checkpoint metadata and command-operation metadata.
- Emit a durable `workspace.rebuilt` or `workspace.reset` event with the old and new generation and a clear data-loss message.
- When a checkpoint belongs to an older generation, prepend a reset instruction before resuming Pi. The instruction must state that the filesystem was replaced, uncommitted files and local unpushed commits may be gone, and Pi must inspect the current `/workspace` before continuing.
- Re-clone the configured public repository before resuming against a rebuilt workspace.
- Do not silently describe a new VM as the old filesystem.
- Set a finite provider-side maximum lifetime for Freestyle workspaces so an unrecoverable worker cannot leave paid compute running indefinitely.

## Workstream 5: define the Pi event and checkpoint contract

Priority: P1 for failure handling, P2 for storage growth

### One ordered writer

- Send `tool.started`, tool output, `tool.completed`, assistant events, and checkpoint writes through one ordered writer per Pi attempt.
- The writer must catch the first persistence failure immediately, retain it, reject later writes, abort the Pi session, and return the failure to the activity.
- Await the writer in the failure path as well as the success path. No rejected event or checkpoint promise may remain unobserved until `session.prompt()` finishes.
- Preserve semantic order. A `tool.output` event cannot appear before its `tool.started` event because another write was bypassing the queue.
- If the run becomes terminal while an event is pending, stop Pi and treat the terminal state as authoritative.

### Tool results

- Treat a nonzero command exit as a tool result, not as a transport error. A failed test, a search with no matches, and `git diff --exit-code` are valid information for Pi.
- Persist stdout, stderr, and the exit code before deciding how Pi should interpret the result.
- Include the exit code and a bounded diagnostic in `tool.output` or `tool.completed`. Keep transport, timeout, cancellation, and output-limit failures distinct from a nonzero process exit.
- Apply one configured output limit to Docker and Freestyle. Mark truncated output in the event payload instead of silently dropping diagnostics.
- Preserve tool diagnostics when a command fails. Do not throw from `commandOutput()` before the output event is written.

### Assistant attempts and event identity

- Give each Pi execution attempt an `attemptId`.
- Include `attemptId` in assistant and tool event payloads and dedupe keys.
- Use a `deltaIndex` that is unique within an attempt. Do not reset a counter while reusing dedupe keys or appending to an earlier partial assistant response.
- Start a new assistant attempt after a retry. Consumers must discard or hide an incomplete earlier attempt when a later attempt starts, and use the final persisted assistant message when the run completes.
- Keep the run ID in every event payload so consumers can group events without relying on event order alone.

### Checkpoints

- Do not save the full Pi `entries` array on every `entry_appended`, `turn_end`, and `agent_end` event.
- Save at a durable turn boundary at minimum. Prefer incremental session-entry storage so long sessions do not rewrite an ever-growing JSON document.
- Enforce a checkpoint size limit and define the behavior when the limit is reached. The runner must compact, start a new session, or fail with a clear bounded error.
- Bind a checkpoint to the workspace generation and assistant attempt that produced it.
- Keep the completion checkpoint separate from the resumable session checkpoint.
- Add tests for persistence failure, ordered event writes, retry attempts, output limits, checkpoint size, and the no-built-in-tools boundary. The test must verify that Pi cannot fall back to a worker-local `bash`, `read`, or `edit` tool.

## Workstream 6: recover repository promotion and simplify the shell path

Priority: P2

Repository initialization must fail closed for an incomplete checkout while recovering a completed copy. The current backup branch is unreachable in the active promotion design, and the shell script contains portability paths for operating systems that the controlled Ubuntu snapshot does not use.

### Requirements

- Keep a small promotion state machine with an explicit marker containing the workspace key and requested repository identity.
- On startup, if a marker exists, inspect the target workspace and staging checkout:
  - If the target has a valid matching origin and `HEAD`, clear the marker and staging data and return `reused`.
  - If the staging checkout is valid and the target is still empty, resume or repeat the copy.
  - If the target is partial and the marker proves that the runner created it during this promotion, remove that partial target and repeat the copy.
  - If the target is mismatched or is not provably runner-owned, fail without deleting its files.
- Test the crash window after `cp -a` completes and before marker cleanup. A valid target must not be rejected forever.
- Remove the unreachable `workspace_backup` recovery branch, `promotion_started`, and `cloud-swe.checkout-complete` unless a new recovery path uses them.
- Factor origin comparison into one shell helper.
- Target the supported Ubuntu 24.04 snapshot. Remove unused BSD, BusyBox, and `setsid` compatibility branches unless a supported provider requires them.
- Quote every shell substitution and argument. In particular, quote the parent directory expression in `remote_write` so paths with spaces work.
- Keep the clone timeout, size limit, free-space limit, no-credential environment, and no-submodule policy from the existing repository spec.
- Accept valid GitHub repository names that begin with a dot, including `.github`, while keeping the owner and URL validation rules strict.
- Reduce `normalizePublicGitHubBranch` to the component regex and the checks that the regex does not express, such as `..`, a trailing dot, `.lock`, and `@{`.

### Branch behavior

Treat the requested branch as the initial checkout target. Validate it and verify it when cloning or rebuilding a workspace. On a normal follow-up, verify the repository origin and a valid `HEAD`, but do not fail only because Pi switched branches. Do not reclone or force the original branch on every follow-up.

## Workstream 7: simplify the provider, database, and API contracts

Priority: P2 and P3

### Provider and database contracts

- Standardize `SandboxProvider` on `WorkspaceRef` and `CommandRequest`. Remove string overloads and the `workspaceRef()` helper after callers migrate.
- Remove `execStep` from the general provider interface. Put scripted behavior behind a scripted executor that uses ordinary `exec` and a provider-independent shape.
- Rename `workspace.dockerName` to a provider-neutral `name`, or remove the stored field if the name can be derived safely. Provider-specific schema names must not leak into Freestyle code or raw SQL.
- Remove `inspectRun` when `loadRun` is its only implementation. Remove `context.auth` while it always returns `null`.
- Make the event store accept a numeric cursor after route validation. Do not convert the cursor from number to string and back.
- Check thread ownership once when an SSE stream opens. Do not repeat the ownership query on every 200 ms poll.
- Make the server own its database pool explicitly. Importing `@cloud-swe/auth` must not open a PostgreSQL pool as a module side effect.

### API choice

Use the existing hand-written Fastify `/api/...` routes as the canonical thread API. They already implement the real thread, message, cancellation, and SSE behavior. Remove the unused scaffold oRPC and OpenAPI routes. Do not keep two public API paradigms for the same product.

The web app must use the canonical API for creating threads, reading snapshots, streaming events, submitting follow-ups, and cancelling runs. Add an end-to-end check that exercises the same path the web app uses.

### CSRF and public-demo admission

- Protect every cookie-authenticated state-changing route, including cancellation, with an origin check and a CSRF token or an equivalent same-site design.
- Do not treat CORS as CSRF protection. A cross-origin form POST can send a cookie even when the browser blocks the response.
- Add a test that sends a cancellation request from an untrusted origin and verifies that the run remains active.
- Require verified email or another trusted authentication state before launching compute in the public demo.
- Keep a global active-run limit, one active workspace per user, per-user rate limits, bounded run duration, idle pause, and abandoned-workspace cleanup.
- Return clear `401`, `403`, `404`, `409`, and `429` errors without exposing provider credentials or internal filesystem details.

## Workstream 8: remove scaffolding and align documentation

Priority: P3

After the safety changes land:

- Remove the duplicated provider overloads, scripted `execStep`, unused checkpoint branches, dead symbols, duplicate imports, and misleading comments.
- Simplify `infra/freestyle/Dockerfile` and `bootstrap.sh` around one capability list. Keep the Dockerfile as a local image recipe, but do not duplicate a full VM bootstrap without a clear validation purpose.
- Replace the embedded Node programs in `rebuild-snapshot.sh` with standard tools where they provide the same result. Keep snapshot IDs and manifest versions reproducible.
- Remove or relocate committed `.codex/`, `.agents/skills/astra-orchestrator/SKILL.md`, and `.codex/agents/*.toml` tooling from the portfolio repository if the project does not need them at runtime.
- Update `README.md`, `docs/backend-contract.md`, and `docs/freestyle-sandbox-spec.md` whenever behavior changes. Do not describe stable dedupe keys, branch preservation, workspace durability, or recovery behavior that the code does not provide.
- Remove repository tests for the unreachable backup branch and replace them with promotion-completion recovery tests.

## Test plan

Keep the current real integration scenarios. Change how they run and add failure coverage.

### Runner and provider tests

- Kill a worker after a Freestyle command is accepted. Verify that a retry reconciles the command and does not start a concurrent command.
- Cancel before provider dispatch. Verify that no command is created.
- Cancel or time out after dispatch. Verify that the workspace remains owned until the command settles or becomes reconciled.
- Lose a provider ID after VM creation. Verify slug lookup, managed metadata validation, provider ID persistence, and cleanup.
- Delete or lose a VM. Verify generation increment, repository re-clone, reset event, reset instruction, and no silent stale-session resume.
- Exercise a provider timeout, a nonzero command exit, an output limit, and a transport error separately.
- Write a path containing spaces with `remote_write`.
- Verify that Pi only receives the custom remote tools and never operates on the worker filesystem.

### Database, workflow, and API tests

- Test simultaneous submissions against the global limit and the database unique indexes.
- Accept a follow-up while its outbox record remains undelivered. Verify that cleanup does not delete the workspace.
- Use Temporal's test environment with time skipping for idle pause, cleanup, continue-as-new, cancellation before start, and finalization after a retry.
- Split the long backend integration test into phases. Replace fixed sleeps with polling for the expected state and bounded test deadlines.
- Test ordered SSE replay, one ownership check at stream open, reconnect cursors, and notification wakeups if enabled.
- Test assistant attempt identity and event ordering after a persistence failure and a retry.
- Test repository promotion recovery after a completed copy, incomplete target, mismatched origin, mismatched branch at initialization, and valid `.github` repository names.
- Test CSRF rejection for cancellation and other state-changing routes.
- Test the canonical API path from the web app.

### Required validation

After implementation, run:

```sh
bun run check-types
bun run check
bun run test:db
bun run test:backend
```

Run the paid Pi and Freestyle integration suite when credentials and a disposable provider account are available. Run `sh -n` against changed shell scripts and run the snapshot verification script after changing the image recipe.

## Implementation order

Implement in this order:

1. Add command ownership, provider reconciliation, cancellation boundaries, and finite provider cleanup limits.
2. Add the database cleanup guard and workspace generation handling.
3. Split workspace preparation from Pi and scripted execution. Separate timeout and retry budgets.
4. Fix the ordered Pi writer, nonzero command results, assistant attempt identity, checkpoint boundaries, and output limits.
5. Recover repository promotion and fix shell quoting and GitHub-name validation.
6. Add CSRF protection, verified-compute admission, injected provider configuration, and Turbo environment forwarding.
7. Choose the canonical API route set and connect the web app to it.
8. Remove dead interfaces and scaffolding, simplify infrastructure scripts, optimize SSE wakeups, and update all docs.

The work is complete when all invariants hold, the P1 failure tests pass against a real Temporal and PostgreSQL setup, the API contract matches the implementation, and the related docs describe observed behavior rather than intended behavior.
