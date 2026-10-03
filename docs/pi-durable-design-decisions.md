# Pi Durable design decisions

## Decision

Borrow Pi Durable's context compaction design, but do not add `@earendil-works/pi-durable`.

The runner currently disables Pi compaction in [`apps/runner/src/pi.ts`](../apps/runner/src/pi.ts). A long conversation can therefore grow until the model rejects the request or the resumable checkpoint reaches its size limit.

The installed `@earendil-works/pi-coding-agent` already supports automatic compaction. Our database decoder already accepts compaction entries, and checkpoint storage already keeps session entries in separate rows. This change uses those existing pieces. It does not add a second scheduler, storage engine, or event system.

Do not borrow the other Pi Durable designs for this backend:

- PostgreSQL already provides atomic submission, checkpoint, approval, question, event, and outbox writes.
- Temporal already provides durable retries, cancellation, timers, and recovery.
- The execution coordinator already owns command identity and reconciliation for ambiguous remote outcomes.
- The API already provides a snapshot followed by ordered SSE events.
- A new task graph, document registry, or capability registry would add code without removing a current failure mode.

## Desired behavior

When the projected context approaches the selected model's limit, Pi should:

1. Summarize older context.
2. Append a validated compaction entry to the versioned session with the summary and the first retained entry.
3. Keep recent messages and tool results in the active context.
4. Persist the compaction entry at the next checkpoint boundary.
5. Resume from the same compacted session after a worker restart.

Raw session history remains available in the checkpoint entry rows. Compaction changes what Pi sends to the model. It does not delete the stored transcript.

## Implementation

### 1. Enable the existing Pi SDK feature

Change the `SettingsManager.inMemory` configuration in `apps/runner/src/pi.ts`:

- enable automatic compaction;
- use bounded reserve and recent-context settings supplied by the installed SDK;
- derive the active model context window from the selected model;
- keep retry behavior explicit and separate from compaction.

Do not expose new user settings in the first implementation. Use worker defaults so every run follows the same bounded policy.

### 2. Persist compaction through the existing writer

Subscribe to the SDK's compaction lifecycle events. Use them to schedule persistence and bounded diagnostics. Do not add a public SSE event for compaction in the first implementation. Keep the full summary in the validated Pi session checkpoint.

Queue a checkpoint after successful compaction. The existing turn-boundary checkpoint remains the normal path. Both paths use the current attempt ID, ownership token, workspace generation, and checkpoint size limit.

Compaction uses the current activity signal, credential, and execution budget. It cannot extend the run deadline or bypass cancellation.

If compaction fails, keep the previous committed checkpoint authoritative. Return a bounded model or checkpoint failure through the existing activity and Temporal recovery path. Never replace a valid checkpoint with a partial summary.

### 3. Keep database and checkpoint contracts unchanged

Use the existing versioned decoder in `packages/db/src/checkpoint.ts`. Confirm that it validates the compaction entry's summary, retained-entry ID, parent links, and token metadata.

Keep the current incremental entry storage in `packages/db/src/threads/checkpoints.ts`. Unchanged entry rows must remain untouched. The compaction entry is appended to the session history like any other validated entry.

Do not put model summarization inside a PostgreSQL transaction or a Temporal workflow. The runner performs the model call. PostgreSQL stores the resulting immutable checkpoint under the current execution ownership.

## Verification

Add focused tests before enabling this for all runs:

- A long fake session triggers compaction before the model context overflows.
- The saved checkpoint contains the compaction entry and all retained entries.
- Loading the checkpoint after a worker restart rebuilds the same active context.
- A compaction checkpoint preserves `attemptId`, ownership, and workspace generation.
- A failed or cancelled compaction leaves the last committed checkpoint readable.
- Repeated compaction does not duplicate summaries or delete retained tool results.
- The checkpoint size limit still fails with a bounded error when a summary itself is too large.

Run the existing Pi, checkpoint-compatibility, database, and backend recovery tests. Then add one worker-restart test that resumes from a compacted session.

## Acceptance gate

Ship the change only if it reduces context-overflow failures without changing:

- PostgreSQL event sequence or SSE cursor behavior;
- checkpoint ownership and workspace-generation checks;
- Temporal retry and cancellation behavior;
- remote command reconciliation;
- per-user model credential handling;
- the rule that Pi receives project-owned remote tools instead of worker-local coding tools.

If compaction requires a second durable runtime, a second event log, or a bypass around checkpoint ownership, stop the work. The change would no longer simplify this backend.
