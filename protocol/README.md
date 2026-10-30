# First slice: cloud Pi on Boat

Create/list/get sessions, message submission/steering/queueing, cancellation and operation receipt lookup are implemented; remaining schemas describe later endpoints. These are application contracts, not native Pi wire types. See [source verification](SOURCE-VERIFICATION.md) and [server status/testing](../server/README.md). Import runtime schemas and inferred types from `@cloud-swe/protocol`. This private workspace package exports TypeScript source for bundler-based clients/backends; it has no Node-only runtime dependencies.

## Shipping target

A personal authenticated Hono API owns one Pi session through a Thread Durable Object/PiHarness, using its own server-provisioned Boat sandbox for read/write/shell tools ([design](../AGENTS.md#workspaces)). Pi Durable owns the transcript. No second agent loop on Boat. Public workspace endpoints, Claude, Mac, approvals, delegation, UI, and MCP are out of this slice.

Before runtime work, configure an allowlist of Boat environments and a server-side model allowlist. Requests select those references, never supply provider credentials or arbitrary runner URLs. File/shell access is privileged personal access, not a multi-tenant sandbox.

## HTTP surface (sessions, messages, cancellation and receipt lookup implemented; others proposed)

Every route requires `Authorization: Bearer <personal API token>` over HTTPS. This is our API token, not a model-provider or Claude subscription token. Authenticate and check ownership before session/operation lookup; inaccessible IDs return 404. No credentials in URLs or SSE payloads.

| Method | Path                                              | Input                  | Success schema/status                       |
| ------ | ------------------------------------------------- | ---------------------- | ------------------------------------------- |
| POST   | `/v1/sessions`                                    | `CreateSessionRequest` | `CreateSessionResponse`, 201 (200 on retry) |
| GET    | `/v1/sessions`                                    | `PageQuery`            | `ListSessionsResponse`, 200                 |
| GET    | `/v1/sessions/:sessionId`                         | `SessionParams`        | `Session`, 200                              |
| POST   | `/v1/sessions/:sessionId/messages`                | `SubmitMessageRequest` | `OperationReceipt`, 202                     |
| POST   | `/v1/sessions/:sessionId/cancel`                  | `CancelRunRequest`     | `OperationReceipt`, 202                     |
| GET    | `/v1/sessions/:sessionId/operations/:operationId` | `OperationParams`      | `OperationReceipt`, 200                     |
| GET    | `/v1/sessions/:sessionId/snapshot`                | `SessionParams`        | `Snapshot`, 200                             |
| GET    | `/v1/sessions/:sessionId/history`                 | `PageQuery`            | `HistoryResponse`, 200                      |
| GET    | `/v1/sessions/:sessionId/events`                  | `SessionParams`        | SSE containing `SessionEvent`, 200          |

JSON mutation bodies are strict. Reject oversized bodies before parsing (128 KiB ceiling); reject invalid schema input with 400, missing/invalid authentication with 401, missing resources with 404, conflicting operations/stale runs/busy sessions with 409, unavailable dependencies with 503, and unexpected failures with 500. All JSON errors use `ApiError`. Error messages must be sanitized, not raw exceptions/secrets. Validate outbound responses too.

## Admission and recovery rules

- The client generates a UUID operation ID **before** sending, and reuses it on retries. Scope session creation IDs to the authenticated owner; scope message/cancel IDs to owner + session. Retain creation mappings and accepted receipts for the session lifetime; do not expire them while a session remains usable.
- Same operation ID + same parsed intent returns the original result. Same ID + different action/payload returns `operation_conflict` (409). Check deduplication before busy/run checks. Creation retries return the same session ID and current session metadata.
- Persist intent before dispatch; use the logical ID as Pi's admission request ID and reconcile on recovery. An HTTP timeout is not rejection. Operation lookup returns a receipt only after confirmed admission; unresolved admission returns 503, not an invented success. Retry the original mutation with the same ID, never a new ID to escape uncertainty.
- A receipt means admission, **not completion**. Messages default to `mode: "reject"`; `"steer"` is delivered at Pi's next boundary, and `"followUp"` queues behind the current generation. Steering does not interrupt an in-flight model request and starts normally if idle. Follow-ups are FIFO, at most one per final boundary; Pi can consume pending steers at that same boundary. At most 100 native inputs may be pending. `Session.pending` lists their receipts/modes and native queued/running/parked status. This is a projection, not another scheduler.
- Every input gets its own app receipt/run ID, not a Pi task ID: multiple inputs can share a native generation. `Session.run` shows the oldest running input (or first queued input while starting); with no pending input it shows the last admitted input's outcome. Cancellation names one pending app run ID and resolves it to the saved native operation. A queued input is withdrawn without interrupting the active generation; a placed input captures the current pending-input scope **including queued inputs** for cancellation. The scope is persisted before dispatch and never expands on retry. Cancellation resolves a placed input to its bound native task in a Pi transaction and aborts that task, not whichever conversation/task happens to be current later. Delayed/stale cancellations never target a newer input. `cancelling` is not `cancelled`; interruption must be confirmed. Cancellation intents and accepted receipts survive retry/restart.
- `CommandRecord` is internal persisted execution state. Save `prepared` before dispatch. Workspace + runner boot/generation + operation ID identifies intent; a PID/job ID alone is insufficient. Reconcile to the existing job after lost receipts. If launch cannot be proven or disproven, mark `uncertain` and do not automatically re-execute. Null/missing exit codes are not success. Apply the same caution to remote writes.
- An uncertain remote effect blocks new mutating work until reconciled; cancellation must not erase that uncertainty. No exactly-once shell guarantee is claimed.

## Snapshot, history, and SSE

- Snapshot contains current metadata/run state and up to 100 newest entries. History pages go backwards using opaque, session-bound cursors; each page's entries are ordered oldest to newest. Clients prepend older pages and deduplicate by entry ID. Session-list cursors use a stable `(createdAt, id)` order. Invalid/wrong-scope cursors return 400.
- Atomically capture the snapshot and subscribe to subsequent changes so there is no snapshot-to-stream gap. Each new SSE connection starts with `snapshot`; replace the client's live projection before applying later events. Older paginated committed history may remain cached by entry ID.
- Use `event: <kind>` and JSON `data` matching `SessionEvent`. `entry.upserted` replaces the whole entry by ID, including evolving streaming/tool state. Events are ordered within a connection, and heartbeat comments carry no state.
- No SSE `id`, durable event cursor, or token replay guarantee yet. Ignore `Last-Event-ID` and resnapshot on reconnect. If a slow client loses buffered updates, close the stream and resnapshot rather than silently dropping entries. After headers are sent, transport failure closes the stream; it cannot become a JSON error response.
- Streaming text is provisional; committed transcript entries remain authoritative after restart. No parallel application transcript database. `unreachable` is not `stopped` or `idle`.

## Acceptance gate for the later implementation

1. Auth/ownership rejection and all responses validated against this package.
2. Lost create/message receipt + same-ID retry admits one session/input; changed intent returns 409.
3. One prompt reads/writes a file and runs a shell command in the assigned Boat workspace.
4. Disconnect/reconnect during tool execution produces a consistent snapshot and later updates.
5. Cancel a specific run; a stale cancel cannot affect its successor.
6. Crash before/after remote launch and before saving its handle: reconnect to the same job or surface uncertainty, never blind replay.

Run `pnpm test` from the repository root: contract tests, typechecks and session-creation integration tests all execute inside Docker. `pnpm test --boat` explicitly switches workspace checks to Boat through `@boatdev/sdk` (requires credentials and a running sandbox). Creation and message admission/retry/restart behavior are tested. Model transport is intercepted, with no paid model calls. Steering, FIFO follow-ups, queued/active cancellation, stale-cancel rejection and restart receipts are tested. Tool/SSE fault-injection gates above remain future work.
