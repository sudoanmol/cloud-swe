# AGENTS.md

This file is authoritative for architecture, decisions, security boundaries and how to work here. [`MVP.md`](MVP.md) is the delivery-scope, priority and feature-status checklist. Read both before starting work.

**Keep both current.** When a decision is made, scope changes, or implementation lands, update this file and the relevant scope/status rows in [`MVP.md`](MVP.md) in the same change. Record decisions in [Decisions](#decisions) with a date. `MVP.md` owns release placement/priorities; this file owns architecture/security rules. Fix conflicts in the same change rather than leaving contradictory notes. Don't create other design docs or a `docs/` folder; `MVP.md` and the user-requested `EFFECT.md` evaluation/trial record are the exceptions. If a section here goes stale, fix it rather than adding a contradicting note. Package READMEs (`protocol/README.md`, `server/README.md`) describe their code's contracts; if they disagree with this file, this file wins, and the README gets fixed.

## Working rules

- **Build order:** always write the protocol (`protocol/`) and its tests before application code. Then build the backend (`server/`), then its API routes.
- **No god files.** Split files by concern and organize them into folders.
- **Grow in layers.** Each step ships working and tested before the next starts.
- **Stay within the release scope.** Follow the immediate priorities in [`MVP.md`](MVP.md). Backlog additions are not instructions to implement V1 ahead of MVP. Get explicit user direction before promoting V1 work into MVP; update both documents when priorities change.

## Checks

- `pnpm test`: all contract tests, typechecks and integration tests, run inside Docker. `pnpm test --boat` provisions real Boat sandboxes (billed; the suite deletes them) and needs `BOAT_API_KEY`.
- `pnpm lint`: oxlint with the vendored anti-slop plugin (`tools/oxlint/anti-slop/`, see its `UPSTREAM.md`).
- `pnpm fmt` / `pnpm fmt:check`: oxfmt.
- `pnpm knip`: unused files, exports and dependencies.
- `pnpm typecheck`.
- Pre-commit runs lint-staged: `oxfmt`, then `oxlint --fix`, on staged files.
- Local dev: `pnpm dev` loads the root `.env` (copy `.env.example`). Tests inject their own bindings and ignore `.env`.

## Decisions

| Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-29 | **Parallel cloud agents, one Boat sandbox per session, provisioned by the server.** Clients never pick or see a Boat sandbox. Replaces the single pre-assigned workspace (`WORKSPACE_ID` / `BOAT_SANDBOX_ID`). See [Workspaces](#workspaces).                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-29 | **No automatic snapshots.** A sandbox is deleted after 7 days without activity. The user can save a snapshot whenever they want one, and it's kept until they delete it.                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-10-29 | **A session request can specify a repo and branch**, on top of an allowlisted Boat environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-10-29 | **A new session can fork another session's sandbox**, or start from a saved snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-10-29 | **Models: client-managed keys in the private account `Credentials` DO.** Same Worker, not a separate broker deployment. The Anthropic Worker secret is a development/testing fallback; deleting a client key disables that fallback. See [Model authentication](#model-authentication).                                                                                                                                                                                                                                                                                             |
| 2026-10-29 | **No Git credentials inside sandboxes.** Remote Git access is controlled at the tool boundary: public repos clone anonymously; private reads and pushes go through a Git proxy in the Worker. See [Repository access](#repository-access).                                                                                                                                                                                                                                                                                                                                          |
| 2026-10-29 | **V1 provider sign-in:** client-initiated ChatGPT authorization for Pi, with refresh/write support in the account `Credentials` DO; client-initiated official Claude Code sign-in for the Claude runner, subject to supported-flow/hosted-use verification. Manual `setup-token` remains a fallback, not the client sign-in implementation. Claude runner credentials remain the accepted sandbox-exposure exception. See [Model authentication](#model-authentication).                                                                                                            |
| 2026-10-29 | **Effect v4 for workspace orchestration only.** Keep Hono, Zod, PiHarness and DO persistence; implementation findings and source references live in [`EFFECT.md`](EFFECT.md).                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-29 | **Pi-native steering and queued follow-ups are in slice 1.** Explicit message modes retain reject-if-busy as the default. Pi owns scheduling; each input gets an app receipt/run ID even when several inputs share a native generation. Active cancellation freezes the current pending-input scope, including queued inputs, and aborts only tasks bound to those inputs; queued cancellation targets only that input. Like Pi's interactive Escape, cancellation returns queued text in `restoredMessages` for the client to restore to its editor; it is not silently discarded. |
| 2026-10-29 | **Slice 1 backlog expanded:** Pi tree-style conversation navigation/reversal (conversation-only by default), automatic and manual compaction, and image attachments. R2 is a candidate for image storage, not yet selected.                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-29 | **MVP/V1 delivery split lives in [`MVP.md`](MVP.md).** MVP proves a personal Pi coding task with Anthropic API keys and a fine-grained GitHub PAT. Richer interaction, package parity and client-initiated ChatGPT/Claude sign-in are V1; keep scope and status current in both files.                                                                                                                                                                                                                                                                                              |

## Status

As of 2026-10-29, slice 1 (cloud Pi vertical slice) is partly built:

| Piece                                                                                         | Status                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated Hono API (bearer token, body limit, sanitized errors)                           | Done                                                                                                                                                                                                          |
| Thread DO per session running a real PiHarness and native root conversation; survives restart | Done                                                                                                                                                                                                          |
| `SessionCatalog` DO: idempotent create, paginated list, get                                   | Done                                                                                                                                                                                                          |
| Workspaces                                                                                    | One sandbox per session: provisioned with Boat's idempotency key, polled until running. Lost-ID lookup by exact sandbox name is implemented. Repo clone, fork, snapshots, lifecycle and the cap are not built |
| Model credentials                                                                             | Client-managed Anthropic key in a private Credentials DO; live rotation/deletion, Worker-secret test fallback; sanitized model errors                                                                         |
| Message submission, steering, queueing, cancellation and operation lookup                     | Durable intents and receipts, explicit reject/steer/followUp modes, bounded pending-input projection, native cancellation                                                                                     |
| File/shell tools, command reconciliation                                                      | Schemas only in `protocol/`                                                                                                                                                                                   |

Routes: create/list/get sessions, `POST /v1/sessions/:sessionId/messages`, `POST /v1/sessions/:sessionId/cancel` and `GET /v1/sessions/:sessionId/operations/:operationId` exist. Snapshot, paginated history and snapshot/reset SSE are also implemented; all nine session routes in `protocol/README.md` now exist. SSE uses scoped Effect cleanup and a single buffered replacement snapshot, not durable token replay. Slices 2–5 are not started.

### Backlog details and release placement

Requested 2026-10-29, originally recorded under slice 1; these are requirements, not completed features. [`MVP.md`](MVP.md) now separates MVP from V1 and owns their delivery placement. Automatic compaction is an MVP verification gate; manual compaction and the other additions below are V1 unless explicitly reprioritized. Architectural slices and release phases are not interchangeable. Follow the protocol-first build order above.

- **Conversation tree/history navigation:** select an earlier conversation point using Pi tree-style navigation and replace the session's active conversation context with that selection. Keep the previous branch available for later navigation; do not merely open a read-only history view or run two active writers. Default to **conversation-only reversal**, leaving sandbox files unchanged. The UI may offer a separate, explicit code-reversal choice if a suitable filesystem/Git checkpoint exists. Conversation navigation does not itself restore code or a Boat snapshot, and must not introduce automatic Boat snapshots. Verify the Pi Durable branch/head integration rather than assuming coding-agent's tree API is interchangeable.
- **Automatic and manual compaction:** configure and verify Pi-native automatic context compaction, and expose an explicit manual compact action, including optional instructions where supported. Report compaction progress/completion/failure through snapshot/SSE, preserve navigable history, and test interruption/restart and queued-message behavior. Use Pi's compaction machinery, not a second summarization loop.
- **Image attachments:** accept images from the client, retain attachment references in conversation history, and send supported image content to the selected model. Evaluate **R2 for image bytes**; storage choice and retention are not yet settled. Keep large image bytes out of DO transcript rows, enforce authenticated access and upload size/type limits, and preserve attachment availability across reconnects/restarts.

- **Local Pi package parity:** support the user's current package set below, including its client-facing interactions, not just package installation. Audit each package's coding-agent extension/TUI dependencies against Pi Durable before implementation. Decide per package whether its existing implementation can be reused or needs a Durable/native-client adapter; do not silently substitute behavior or claim CLI extensions work unchanged. If unmodified package compatibility requires a Boat-hosted coding-agent runtime, explicitly revisit the runtime decision rather than introducing a second active session owner.

  ```json
  [
    "npm:@juicesharp/rpiv-ask-user-question",
    "npm:@juicesharp/rpiv-web-tools",
    "git:github.com/DietrichGebert/ponytail",
    "npm:@juicesharp/rpiv-todo",
    "npm:@plannotator/pi-extension",
    "npm:@aliou/pi-processes"
  ]
  ```

  Questions/answers, todo updates and review interactions must reach the client through structured API/events where applicable. Skills/prompts must be loaded deliberately. Process tools must execute in the session's Boat sandbox, not spawn processes in the Worker. Keep any provider/API credentials server-side and verify each package's requirements before advertising support.

- **Client terminal:** let the authenticated client open/control a terminal in its session's Boat sandbox, independent of model tool calls. Support streamed output, input, resize, termination and reconnect with explicit process identity. Stop/resume and lost execution receipts must report interruption/uncertainty rather than imply a shell survived or blindly rerun a command. The terminal receives no upstream Git/model credentials and cannot target another session's sandbox.
- **Port preview URLs:** expose running sandbox services to the client through Boat-backed port previews. Verify Boat's URL, authentication and lifecycle semantics; scope access to the owning session, surface stopped/unreachable services, and handle URL changes on resume. Do not expose arbitrary ports publicly by default or embed upstream credentials in preview URLs. Explicit public sharing, if needed, is a separate opt-in policy.
- **Computer use and browser automation:** integrate Boat's built-in computer-use capabilities and install/support `agent-browser` for CLI-driven browser automation inside the assigned sandbox. Project actions, results and screenshots to the client; reuse the image-attachment storage/access policy where appropriate. Verify Boat environment dependencies and browser/display lifecycle, and distinguish browser automation from desktop control. This controls the Boat sandbox, not the user's Mac or browser. No Git/model credential injection is implied.

## Workspaces

Status: **build step 1 done** (fresh sandbox per session). Later steps are designed, not built.

Cloud agents run in parallel, each in its own Boat sandbox. Concurrent agents editing one checkout corrupt each other through a shared Git index and working tree (see [Agent-to-agent communication](#agent-to-agent-communication)), so one sandbox per session gives one writer per filesystem without lease bookkeeping. Codex cloud tasks and Cursor background agents follow the same pattern.

### Ownership

| State                                                                  | Authority                                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which sandbox a session uses, its lifecycle state, the concurrency cap | `SessionCatalog` DO (workspace records next to session records)                                                                                                          |
| Pi transcript, runs, tool tasks                                        | The session's `Thread` DO                                                                                                                                                |
| Files, processes, Docker data                                          | The Boat sandbox                                                                                                                                                         |
| Templates: base image, env vars, setup                                 | Boat environments, selected by name through `WORKSPACE_ENVIRONMENTS`. Every account has `base`. An environment must not pass Git or model credentials into its sandboxes |

A workspace ID is an application UUID. It maps to a Boat sandbox ID on the server, and the two stay distinct. A restored or forked workspace gets a new Boat sandbox under a new workspace record.

### Records

```ts
Workspace {
  id: WorkspaceId;               // app UUID, minted with the creation intent
  sessionId: SessionId;          // exactly one session per workspace
  environment: string;           // allowlisted app name -> Boat environment id
  repo: { url: string; branch: string } | null;
  source: { kind: 'fresh' } | { kind: 'fork'; workspaceId: WorkspaceId } | { kind: 'snapshot'; snapshotId: SnapshotId };
  boatSandboxId: string | null;  // null until Boat returns it
  state: 'provisioning' | 'ready' | 'stopped' | 'deleted' | 'failed' | 'uncertain';
  lastActiveAt, createdAt, updatedAt: Timestamp;
}

Snapshot {                       // only created when the user asks
  id: SnapshotId;
  workspaceId: WorkspaceId;
  boatSnapshotId: string;
  createdAt: Timestamp;
}
```

`uncertain` means a create may have happened, but no sandbox ID was recorded and Boat's 24 h idempotency window has passed. Never assume it didn't happen; surface it.

### Session creation

The client stops sending `workspaceId`. It names an allowlisted environment and optionally a repo and branch, or a source to fork or restore from:

```json
{ "operationId": "…", "engine": "pi", "target": "cloud", "environment": "cloud-swe",
  "repo": { "url": "https://github.com/…", "branch": "main" }, "model": { … } }
```

To fork or restore, the request sends `"from": { "session": "<sessionId>" }` or `"from": { "snapshot": "<snapshotId>" }` instead of `environment` and `repo`.

1. Validate the request. Unknown environments are rejected (400), and so are requests over the concurrency cap (`busy`, 409).
2. In one storage write, persist the creation intent with a fresh `sessionId` and `workspaceId`, plus the workspace record in `provisioning`.
3. Call Boat with `idempotencyKey` = the operation ID. It's a UUID and unique per account, so a retry within 24 h returns the same sandbox, not a second billable one.
   - **Fresh:** `create` with `environment` and `name: cloud-swe-<workspaceId>`, then clone the repo (see [Repository access](#repository-access)).
   - **Fork:** `fork` the source session's sandbox if it still exists.
   - **From snapshot:** `create` with `from` set to the saved snapshot (the SDK documents this).
4. Record `boatSandboxId`, then wait for a ready state (`inspectWorkspace` already maps Boat states).
5. Open the `Thread` DO and PiHarness root, then index the session.

Retries of the same operation resume from whichever step was last committed. A changed intent under the same ID is still 409. If a crash left `boatSandboxId` null, look the sandbox up by `namePrefix: cloud-swe-<workspaceId>` before retrying the create.

Admission commits the intent under `blockConcurrencyWhile`; provisioning runs outside it, so parallel creations do not queue behind each other. Before creating without a saved sandbox ID, Boat lookup uses the stable name and requires a complete, unambiguous result. A recovered ID can be saved even after the 23-hour retry margin; an absent ID past that margin remains uncertain, with no create.

Boat errors to handle:

- `409 idempotency_in_progress`: the first request is still creating the sandbox. Retry shortly with the same key.
- `409 idempotency_key_reused`: same key, different body. This is a bug in our request derivation; fail.
- Timeouts and 5xx: safe to retry with the same key within 24 h.

### Lifecycle

```text
provisioning -> ready <-> stopped -> deleted
                Boat auto-stop       SANDBOX_DELETE_AFTER_DAYS without activity
                (resume on message)
```

- **Running:** Boat auto-stops a sandbox after 1 h by default, and commands don't extend the deadline. While a run is active, extend it with `update`'s `ttlSeconds`. _Verify_ that `ttlSeconds` controls the auto-stop timer and not deletion; the SDK leaves it undocumented.
- **Stopped:** Boat's own auto-stop is the idle stop; there's no separate timer. Processes die and the disk is kept.
- **Resume:** `resume` when a message arrives for a stopped session. Report `starting` until the sandbox is ready. Reconcile `CommandRecord`s before admitting new work.
- **Deleted:** a catalog alarm deletes the sandbox after `SANDBOX_DELETE_AFTER_DAYS` (7) without activity. Boat would delete a stopped disk after 14 days anyway. The session's transcript stays in its Thread DO, but the session can no longer run tools. To continue the work, start a new session from a snapshot.
- **Snapshot (user action):** `POST /v1/sessions/:sessionId/snapshots` saves a named snapshot of a ready or stopped sandbox. `DELETE /v1/snapshots/:snapshotId` removes it. Snapshots are never created or deleted automatically.

### Cost and the concurrency cap

From [Boat pricing](https://docs.boat.dev/pricing), checked 2026-10-29. The $20/month plan is $20 of included usage. Unused credit expires, and overage is billed from a wallet at the same rates.

| Size      | CPU / RAM / disk        | Per hour | Hours included in $20 |
| --------- | ----------------------- | -------- | --------------------- |
| `small`   | 2 vCPU / 4 GB / 51 GB   | $0.018   | 1,110                 |
| `default` | 4 vCPU / 8 GB / 51 GB   | $0.036   | 555                   |
| `large`   | 8 vCPU / 16 GB / 111 GB | $0.072   | 277                   |

- **The real limit is hours, not concurrency.** The plan allows 100 active sandboxes, with start limits of 12 / 60 / 200 (the pricing page doesn't say per what).
- On `default`, 555 h a month is about **4 agents running in parallel for 6 h every workday** (4 × 6 h × 22 days = 528 h).
- Stopped sandboxes cost no machine time. Saved snapshots include 10 for free, then $1.68 a month each.
- **Default cap:** `MAX_SANDBOXES=4` running `default` sandboxes. Raise it if your usage allows.

### Configuration

| Step     | Removed                           | Added                                                            |
| -------- | --------------------------------- | ---------------------------------------------------------------- |
| 1 (done) | `WORKSPACE_ID`, `BOAT_SANDBOX_ID` | `WORKSPACE_ENVIRONMENTS`: comma-separated Boat environment names |
| 3        |                                   | `MAX_SANDBOXES`, `SANDBOX_DELETE_AFTER_DAYS`                     |

Protocol changes:

- `CreateSessionRequest`: `workspaceId` removed and `environment` added (step 1, done). Optional `repo` (step 2) and `from` (step 4) come with the steps that use them.
- `Session.workspace` keeps the app workspace ID and the lifecycle states above.
- New `Snapshot` schema and snapshot routes.

### Testing

- **`pnpm test --boat`:** the real provisioning, fork and snapshot paths against Boat. It creates, then cleans up, labelled test sandboxes. This costs money, so it must be explicit.
- **Docker (default):** the sandbox service gains `POST /workspaces`, which creates an isolated directory per workspace with its own token. It mimics provisioning and idempotency; real isolation is only proven in Boat mode.
- **Fault cases:**
  - crash after the intent is saved but before `create`
  - crash after `create` but before recording the sandbox ID (lookup by name)
  - concurrent identical retries
  - cap reached
  - sandbox stopped mid-run

### Build steps

1. **Done:** protocol changes plus tests, then catalog workspace records, provisioning with the idempotency key, and the Docker test double.
2. Slice 1 file and shell tools, each targeting the session's own sandbox. Public repo clone.
3. Lifecycle: auto-stop extension during runs, resume, the 7-day delete alarm, the cap.
4. Fork, user snapshots, and starting from a snapshot.
5. Git proxy for private repos and pushes.

Deferred until needed: a periodic sweep for sandboxes with no record (the lookup by name covers the crash case).

## Repository access

No Git credentials enter a sandbox: not in its files, env vars, commands or Boat environment secrets. An agent controls its sandbox's shell, so anything placed there is usable without the tool boundary.

- **Public repos:** clone anonymously over HTTPS.
- **Personal auth:** a fine-grained GitHub PAT, selected over GitHub App OAuth for one-person setup simplicity (2026-10-29). Store it in the private account `Credentials` DO via a write-only authenticated client API. GitHub Apps remain deferred until multi-user onboarding is needed. Private clone/push is part of the current implementation scope, not public-only.
- **Private repos and pushes (build step 5):** the sandbox's `origin` points at a Git proxy route in the Worker, using a per-session capability token that expires. The Worker resolves the account's GitHub fine-grained personal access token from the private `Credentials` DO and forwards Git's smart-HTTP requests to GitHub:
  - fetches are allowed for the session's repo only
  - pushes are allowed only to the session's own branch (`cloud-swe/<sessionId>`), so the agent can never push to `main` or other branches
  - other upstream URLs and redirects are rejected
- The original cloud-swe's GitHub App, bundle staging and push approvals are deferred until there's a need for multi-user access or review before every push.

## Model authentication

**Implemented:** authenticated `PUT`/`GET`/`DELETE /v1/credentials/models/anthropic` set, inspect metadata for, and disable the account's key in a private `Credentials` DO. The read-only Pi adapter resolves that key afresh for auth/model requests, so existing Threads see rotation without restart. The optional `ANTHROPIC_API_KEY` Worker binding is a development/testing fallback only; an explicit deletion persists a disabled marker and never reactivates that fallback. Pi explicitly registers the Anthropic provider; ambient environment/file credential resolution is disabled. A session stores an allowlisted model selector (`MODEL_PROVIDER` / `MODEL_ID`). Creation makes no model request. Message admission checks credentials and catalog membership before reserving a run; the selected provider/model are part of the saved intent. Provider stream errors and throws become generic diagnostics before Pi can persist them. Message/receipt endpoints and native run-state projection are implemented; steering and follow-up admission use Pi's native inbox, with at most 100 pending inputs. Cancellation targets a native input by its saved operation ID. Snapshot/history/SSE now project Pi's transcript without copying it into another store. Native entry IDs are session-scoped opaque strings, not fabricated UUIDs; historical run attribution may be null rather than invented. Tools remain unbuilt.

**Storage and integration:**

- The same Worker hosts APIs and the private account `Credentials` DO; there is no separate broker service. The current single-user bearer identity maps to `personal`. Future per-user names must derive from verified server identity, never a caller-supplied user ID.
- Credential writes return metadata only, with `Cache-Control: no-store`. Keys never enter session/Thread/Pi records. No API can read a stored key back.
- The read-only pi-ai `CredentialStore` resolves through the private DO binding and passes to `createModels({ credentials })`. `ANTHROPIC_API_KEY` remains optional for local testing (`wrangler secret put`; root `.env`).
- The model allowlist stays `MODEL_PROVIDER=anthropic` plus `MODEL_ID`.

Rules:

- The key is never returned or logged, and never enters a sandbox. Model calls run in the Thread DO; only tools execute in the sandbox.
- A submission is rejected before reserving compute if its provider has no credential.
- The provider and model are part of a submission's idempotency identity.
- Provider errors are sanitized before Pi checkpoints are saved.

**V1, client-initiated ChatGPT sign-in for Pi:** the client starts and completes Pi's supported provider authorization interaction through authenticated server endpoints; do not treat model-provider sign-in as application login. Expose auth progress/status, disconnect and reauthentication without exposing tokens. OAuth tokens expire, and pi-ai saves the refreshed tokens. Extend the existing `Credentials` DO and Pi adapter with serialized refresh/write support rather than creating a second service. It's the same pi-ai interface, so callers don't change. DO input gates make refreshes happen one at a time (replacing the original's Postgres advisory lock), and device-login state lives in the DO. The original cloud-swe model broker (`~/Developer/cloud-swe`, `docs/backend-contract.md#model-broker`) is the reference.

**V1, client-initiated Claude Code sign-in (`claude -p` / Agent SDK runner, architecture slice 2):** the client initiates an officially supported runner authentication flow and observes its status. Verify the supported browser/device/runner handoff, credential persistence/refresh and hosted-use constraints before implementation; do not invent a third-party Claude OAuth flow or collect passwords/cookies. Authentication belongs to the official Claude runtime, never a Pi provider. The previously selected long-lived `claude setup-token` Worker secret remains a manual bootstrap fallback; Claude Code does not refresh that token. It does not fulfill the requested client sign-in experience. **Known exception to the no-credentials-in-sandbox rule:** Claude Code runs its own loop and Bash tool inside the sandbox, so its token has to be in that process's environment, where its commands can read it. Limit the exposure: inject the token per run, only into Claude sessions' sandboxes; never put it in Boat environments, images or snapshots. The token only grants access to the subscription and can be revoked. See [Claude subscription authentication](#claude-subscription-authentication).

## Architecture research

Everything below is the original architecture evaluation, merged from the former `PLAN.md`. Its decisions stand unless [Decisions](#decisions) overrides them.

Research date: 2026-10-29. This is a source-level evaluation, not a deployment or end-to-end test.

### Requirements established

- Personal use first.
- Pi for API-key model access, including Anthropic API keys; official Claude Code/Agent SDK for Claude subscription use.
- Current authentication scope: Anthropic API keys for MVP. V1 adds client-initiated ChatGPT sign-in for Pi and official Claude Code sign-in for the runner; manual `claude setup-token` is a fallback. The original setup-token research below remains reference, not a completed client sign-in integration.
- Boat for cloud Linux workspaces.
- Parallel cloud agents: the server provisions one Boat sandbox per session, so concurrent tasks never share a filesystem. See [Workspaces](#workspaces).
- A native, agent-agnostic UI eventually, not merely a remote terminal.
- Continue Mac sessions over Tailscale; usually Pi, Claude Code, and Codex.
- Build the server first. iOS, other clients, and an MCP server come later.

### Recommendation

Keep the original Cloudflare control plane and Pi Durable execution model for **cloud Pi sessions**. Add a separate **Claude SDK runner on Boat**. Keep Herdr at the process/terminal layer and behind a local Mac bridge. Do not replace Pi Durable with Herdr solely to get agent-to-agent communication: Pi Durable already supplies the underlying durable conversation/task primitives and working foreground/background subagent examples.

For cloud Claude authentication, V1 now requests client-initiated official sign-in (integration still unverified). The originally selected `claude setup-token` approach remains a manual fallback: store that personal token in infrastructure secrets and inject `CLAUDE_CODE_OAUTH_TOKEN` into the official runner. Persist conversation history separately; the token does not store sessions.

Use a small application-owned session API to present these runtimes consistently. Agent-agnostic presentation does not imply an agent-agnostic backend implementation. Each adapter must retain its engine's conversation, permission, interruption, and resume semantics.

The most important invariant: **one authority runs each engine session**. A DO can own a Pi Durable conversation, or a runner can own a CLI/SDK session; do not let both drive the same session files or conversation concurrently.

### Checkouts and implementation inspected

All repositories were resolved with the librarian skill into `~/.cache/checkouts/github.com/`.

| Repository                             | Checked-out commit                         | Main implementation traced                                                                                                               |
| -------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| earendil-works/pi                      | `f09d01b85e0384647fcab6779d35ab9dabe04be3` | Durable tool recovery, subagent example, execution environments, conversation views, coding-agent SDK/RPC and extension APIs             |
| cloudflare/agents                      | `be1749221ab3efc8be4e976d8e7d8344d1446032` | PiHarness lifecycle/admission/events, SQLite session store, crash tests, example server                                                  |
| herdrdev/herdr-core                    | `298d9c9094ce36c2c80c8bd917032458d5f440f1` | Terminal launch/holder ownership, text input, parent notifications, remote forwarding, kept-terminal recovery, OpenRPC contract          |
| anthropics/claude-agent-sdk-typescript | `e2963809c50847f00143646418177031aa38dd9c` | Public repository structure and session-store examples; the repository does not expose the complete SDK/Claude agent-loop implementation |
| anthropics/claude-agent-sdk-python     | `27858cbba9ecee26a06a90b8d39d3b5596121d11` | Actual subprocess transport and permission/control request implementation                                                                |
| openai/codex                           | `e9854c0aa52d494fa4f4c3683741461e2640011b` | App-server running-thread resume path and CLI remote options                                                                             |

The manifests inspected describe Pi Durable 1.4.0, Agents 0.32.0, and Herdr Core 0.1.14. These describe the checkouts, not a claim that the corresponding npm/release artifacts were installed or tested.

#### Pi Durable: actual recovery boundary

[`src/harness/tool.ts`, approximately lines 150–230](https://github.com/earendil-works/pi/blob/f09d01b85e0384647fcab6779d35ab9dabe04be3/packages/durable/src/harness/tool.ts#L150-L230): the prepare phase validates arguments, runs `beforeTool`, and commits an execute checkpoint containing the final arguments and replay policy before executing. On recovery, execution reruns only when both the stored and current tool definition say `replay: "safe"`. Otherwise the model receives an interrupted result that explicitly says the tool may have partially run.

Consequences:

- Durable agent state is not exactly-once shell execution.
- Never mark arbitrary shell commands safe just to make recovery automatic.
- A remote job needs a persisted identity and reconciliation, not simply another POST after an exception.
- A basic `ExecutionEnv` is a filesystem/command interface, not automatically a durable job protocol. For task-aware reconciliation, a custom shell tool can use `api.taskId`, commits, and runner operation records.

[`test/examples/22-subagent-background.ts`](https://github.com/earendil-works/pi/blob/f09d01b85e0384647fcab6779d35ab9dabe04be3/packages/durable/test/examples/22-subagent-background.ts): named child conversations have durable anchor tasks; reporter tasks submit a message, await its answer, and report back to the parent. Request IDs prevent repeated admission/reporting across restarts. The tool exposes spawn, send, stop, and status. This is executable example/product code to adapt, not an installed universal cross-engine agent bus.

[`test/examples/28-sandbox-per-conversation.ts`](https://github.com/earendil-works/pi/blob/f09d01b85e0384647fcab6779d35ab9dabe04be3/packages/durable/test/examples/28-sandbox-per-conversation.ts): workspace assignment is application state in a document. The environment factory reads that assignment for each conversation. Boat lifecycle ownership belongs in the application, not in model-provider selection.

[`src/harness/view.ts`](https://github.com/earendil-works/pi/blob/f09d01b85e0384647fcab6779d35ab9dabe04be3/packages/durable/src/harness/view.ts) and [README: watching a conversation](https://github.com/earendil-works/pi/tree/f09d01b85e0384647fcab6779d35ab9dabe04be3/packages/durable#watching-a-conversation): a client receives current state and subsequent changes. Reconnection is not guaranteed replay of every token event. Streamed progress can use deferred persistence; default settings permit roughly the newest second of partial output to be lost on a crash. Final entries/task transitions have stronger commit semantics.

#### Cloudflare PiHarness: keep the host integration

[`packages/agents/src/harness/pi/harness.ts`](https://github.com/cloudflare/agents/blob/be1749221ab3efc8be4e976d8e7d8344d1446032/packages/agents/src/harness/pi/harness.ts): PiHarness is library code under `agents/harness/pi`, not just the example's websocket handler. It prepares storage, opens the application's Harness factory, and manages a Lifecycle wake job. It schedules wake work before admitting input and passes the caller's operation ID to Pi as `requestId`.

The host's heartbeat is 30 seconds and each wake waits at most ten minutes before handing off to another alarm. The comments account for the platform's fifteen-minute alarm wall-time boundary. Pass `onWake` through to `Harness.open`: sleeping durable tasks can then release the object rather than being kept alive by ordinary timers. This does not make a single indefinitely streaming provider request immune to platform limits.

[`session-store.ts`](https://github.com/cloudflare/agents/blob/be1749221ab3efc8be4e976d8e7d8344d1446032/packages/agents/src/harness/pi/session-store.ts) delegates to Pi's Cloudflare SQLite adapter with a `pi_` table prefix. The example's NOTES contain historical SQL-rewrite discussion; the current implementation uses Pi's native prefix support. Prefer source over historical notes.

[`tests/harness.test.ts`, approximately lines 278–317](https://github.com/cloudflare/agents/blob/be1749221ab3efc8be4e976d8e7d8344d1446032/packages/agents/src/harness/pi/tests/harness.test.ts#L278-L317) explicitly tests crash/reopen behavior: a safe tool runs again; an unsafe one is reported interrupted. These tests were inspected, not rerun.

The example uses an SQLite-backed Cloudflare Computer filesystem and Dynamic Worker JavaScript execution. That is not a Linux workspace with Docker. Reuse the lifecycle pattern; replace its workspace/tool integration for Boat. Its generated session IDs and permissive example routing are not production authentication or ownership checks.

#### Herdr: useful, but a different kind of runtime

[`crates/herdr-core/src/holder.rs`](https://github.com/herdrdev/herdr-core/blob/298d9c9094ce36c2c80c8bd917032458d5f440f1/crates/herdr-core/src/holder.rs): holder processes own PTYs and child processes independently of the core. Core restarts and viewer disconnects therefore need not kill the terminal's program.

[`api/run.rs`](https://github.com/herdrdev/herdr-core/blob/298d9c9094ce36c2c80c8bd917032458d5f440f1/crates/herdr-core/src/api/run.rs): terminal launch resolves a template or shell command, assigns parent ownership, persists a terminal claim, and asks the holder to spawn. It injects terminal identity into the environment.

[`input.rs`](https://github.com/herdrdev/herdr-core/blob/298d9c9094ce36c2c80c8bd917032458d5f440f1/crates/herdr-core/src/input.rs): `send` uses a per-terminal input queue, waits for human typing to pause, performs a bracketed paste where supported, pauses, and sends the submission key. It refuses normal sends to a reported blocked program unless forced. This is terminal input coordination, not a typed model conversation submission.

[`notes.rs`](https://github.com/herdrdev/herdr-core/blob/298d9c9094ce36c2c80c8bd917032458d5f440f1/crates/herdr-core/src/notes.rs): parent notifications are marked text typed into the parent's terminal. Herdr tracks child news/seen state, notifies about blocked/error/exited children, and ends children with the parent unless configured otherwise. [`remote.rs`](https://github.com/herdrdev/herdr-core/blob/298d9c9094ce36c2c80c8bd917032458d5f440f1/crates/herdr-core/src/remote.rs) supports cross-machine routing and outboxes for certain peer notifications. This is genuinely useful heterogeneous CLI collaboration, but not a transactionally exactly-once conversation transport.

[`kept.rs`, approximately lines 68–100](https://github.com/herdrdev/herdr-core/blob/298d9c9094ce36c2c80c8bd917032458d5f440f1/crates/herdr-core/src/kept.rs#L68-L100): recovery explicitly replaces the lost program with the machine's own shell and clears the template/status fields. `--keep` is not restart-and-resume-agent behavior.

[API contract](https://github.com/herdrdev/herdr-core/blob/298d9c9094ce36c2c80c8bd917032458d5f440f1/schema/README.md): local Unix socket/named pipe, JSON-RPC, optional framed PTY streams, terminal events and OSC 7501 program status. Event sequence numbers restart with the core; subscribers must resnapshot. No universal conversation/tool-approval schema is supplied.

[Security contract](https://github.com/herdrdev/herdr-core/blob/298d9c9094ce36c2c80c8bd917032458d5f440f1/docs/security.md): anyone connected to the API effectively has the core account's shell/file access. Core is not a sandbox or a permission broker. Do not expose the raw socket through an unauthenticated HTTP tunnel or make it reachable by arbitrary sandbox agents on your Mac.

### Recommended topology

```text
Future native clients / CLI; MCP later
                  |
              HTTP + SSE
                  |
Cloudflare Worker / Hono
  authentication, validation, ownership, limits
                  |
Thread Durable Object / application session controller
  admission IDs, engine binding, workspace reference
  approval records, execution reconciliation, UI projection
        |                                  |
        | cloud Pi session                 | cloud Claude subscription session
        v                                  v
PiHarness + Pi Durable                Boat runner service
  DO SQLite transcript/tasks            official Claude Agent SDK
  Pi AI -> API-key providers            -> unmodified Claude Code binary
        |                                injected OAuth token + local session files
        | Boat tools / command jobs       structured events and approvals
        +--------------------+-------------+
                             |
                      Boat Linux workspace
                      repo/worktrees, Docker
                      runner as systemd service
                      optional Herdr for terminals

Separate local execution target, same application API shape:
Future iOS -- Tailscale --> Mac bridge
                            |-- Pi extension or managed RPC/SDK session
                            |-- managed Claude SDK session
                            |-- Codex app-server adapter
                            `-- Herdr terminal discovery/status/control
```

For a Pi-only subagent tree, keep child conversations in the parent's Harness/DO initially so ownership, reporter tasks, and commits remain local. A separate top-level thread can have its own DO. Cross-DO or cross-engine messaging is an explicit external delivery boundary.

Do not run PiHarness for the purpose of pretending that Claude is a Pi model provider. Claude SDK owns its complete agent loop. A Pi agent may delegate a task to a Claude session through an application tool, but should not wrap each Claude turn/tool call in a second reasoning loop.

#### State ownership

| State                                                                    | Authority                                                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Account/thread discovery                                                 | Account-level index; cached metadata, not an extra model runtime                                                                 |
| Pi cloud transcript, submissions, tool tasks, retries                    | Pi Durable in DO SQLite                                                                                                          |
| Claude transcript and native session identity                            | Claude runtime/session storage on the runner; back it up independently of disposable VM retention                                |
| Personal cloud Claude token                                              | Infrastructure secret store, injected into the official runner; not Pi's provider config, source control, or shared VM templates |
| Claude accepted operations, pending application approvals, UI projection | Application controller plus runner receipt records; explicit reconciliation between them                                         |
| Workspace lifecycle and assignment                                       | Application controller reconciled against Boat's actual state                                                                    |
| Files, worktrees, databases, Docker data                                 | Boat workspace or Mac filesystem                                                                                                 |
| Live PTY/processes/screens                                               | Herdr holder/core where used                                                                                                     |
| Mac agent session                                                        | Mac adapter/runtime; cloud index can mirror metadata, not become a second writer                                                 |
| Large logs, attachments, transcript backups                              | R2 when necessary; not a competing live conversation store                                                                       |

A session ID must include or map to a machine/core identity plus engine session identity. Herdr's `t3` alone is not globally unique. Keep application thread IDs, engine session IDs, Boat sandbox IDs, terminal addresses, and operation IDs distinct.

### Claude subscription authentication

Current first-party guidance is more nuanced than 'the SDK grants third-party subscription access.'

- The [plan help article, updated October 7, 2026](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says signed-in Agent SDK and `claude -p` usage still draw from subscription limits. An API key from a linked Console organization instead uses the API-credit/billing path.
- The [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says third-party developers may not offer Claude.ai login/rate limits for their products without prior approval.
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) separately permits hosted unmodified Claude Code under stated conditions, with users authenticating themselves through Anthropic's flow and paying their own inference usage. It prohibits collecting/intermediating users' Claude.ai credentials/session tokens.

For this personal-first build, use your own officially generated Claude subscription token with the official SDK/binary. Do not transplant subscription OAuth into Pi, spoof Claude Code headers, pool accounts, or add an application-owned Claude login flow. Ensure an inherited API-key environment variable cannot silently select the wrong billing path. Re-evaluate the documented hosted-binary conditions and SDK restrictions before adding other users.

The [Python SDK subprocess implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/27858cbba9ecee26a06a90b8d39d3b5596121d11/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L570) builds a Claude command with stream-json output/input and starts a subprocess. Its [query control handler](https://github.com/anthropics/claude-agent-sdk-python/blob/27858cbba9ecee26a06a90b8d39d3b5596121d11/src/claude_agent_sdk/_internal/query.py#L577) invokes `can_use_tool` and writes the control response. This is why the Claude adapter belongs on a process-capable host, not as an in-Worker Pi provider.

[Claude SDK session docs](https://code.claude.com/docs/en/agent-sdk/sessions) describe disk history and explicit session-ID resume. Conversation persistence is not durable resumption of an arbitrary in-flight OS command. Use explicit IDs, not 'continue the newest session in this directory' when concurrent sessions share a workspace.

#### Manual setup-token fallback: credential storage and lifecycle

The original evaluation selected the long-lived token approach. V1 now also requires client-initiated official Claude sign-in; the flow below documents the manual fallback only and does not establish that client integration. [Anthropic's authentication documentation](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) defines the command, token lifetime, environment variable, and limitations. The deployment flow recommended here is:

1. Run `claude setup-token` on a trusted machine. Complete Anthropic's browser authorization flow yourself.
2. The command prints a **one-year OAuth token** and does not save it. Do not paste it into this document, chat, a command committed to Git, or logs.
3. Save it in the deployment's private infrastructure secret store. The precise secret-manager product is not selected yet. The account/controller may hold a secret reference, but should not expose the token in ordinary thread/session records or client responses.
4. Provision the token into the official runner as `CLAUDE_CODE_OAUTH_TOKEN`. It is for Claude Code/Agent SDK only, never a Pi provider credential. Fresh runner VMs can receive it without another browser login.
5. Keep `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, unintended provider-routing flags, and conflicting helper/profile settings out of this runner's environment/configuration. In non-interactive `-p` mode, an API key wins whenever present.
6. Track the documented expiration and provide an auth-required state on expiration/revocation. Generate a replacement and rotate the secret; do not promise perpetual authentication or a full year regardless of revocation.

The token supports subscription model requests. It cannot establish Anthropic's built-in Remote Control sessions or fetch Claude.ai connectors. Locally configured MCP servers still work. This does **not** prevent our own HTTP/SSE/native UI from controlling the official runner. Do not use `--bare`: the documented bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`.

A token authenticates a process, not a conversation. Preserve the runner's session/history directory on saved disk and back up histories independently. If a new VM replaces the old one, token injection restores authentication, but restoring the original conversation also requires its session files or a supported external session store. A default stopped Boat snapshot expires after 14 days.

**Alternative not selected for cloud:** normal Linux login writes `~/.claude/.credentials.json` with mode `0600`; `CLAUDE_CONFIG_DIR` relocates it. Keeping that directory writable and persistent avoids login per process but still permits eventual reauthentication. On macOS, keep using the existing encrypted Keychain login; there is no need to extract and upload the Mac's credentials file.

**Security boundary:** an environment variable or mode-0600 file is not secret from a shell agent running as the same OS user. Do not bake a token into a shared saved snapshot. Restrict secret injection to personal trusted runners; before untrusted/multi-user execution, evaluate a separate credential broker or stronger process/isolation boundary rather than claiming that chmod protects the token from the agent.

### Native UI and Mac continuation

#### One UI, several adapters

Normalize the common surface: session metadata and capabilities, messages/content blocks, tool activity, run status, approval/question requests, and subagent relationships. Preserve raw engine payloads/version metadata for unsupported details and diagnostics. Do not reduce everything to `text` and `busy`, and do not promise that arbitrary TUI widgets can be rendered natively.

Pi Durable has its own API and storage. Pi coding-agent SDK/RPC uses `AgentSession` and `SessionManager`. They share model infrastructure but are not the same runtime or interchangeable live session format. Native UI adapters can support both; that does not make CLI extensions drop into Durable.

#### Mac adapters

1. **Pi interactive sessions already in Herdr:** a Pi extension bridge is the best path for preserving the actual live session. The [extension API](https://github.com/earendil-works/pi/blob/f09d01b85e0384647fcab6779d35ab9dabe04be3/packages/coding-agent/src/core/extensions/types.ts) exposes message/tool events, session-manager reads, and `sendUserMessage` with steer/follow-up semantics. Instrument sessions deliberately; Herdr alone does not expose these events. Serialize competing local/native control. Supporting every extension's custom terminal UI is separate work.
2. **New managed Pi sessions:** [Pi RPC](https://github.com/earendil-works/pi/blob/f09d01b85e0384647fcab6779d35ab9dabe04be3/packages/coding-agent/docs/rpc.md) or the SDK supplies structured state/events. `pi --mode rpc` is a startup mode, not a way to attach to an arbitrary existing interactive process. A successful prompt acknowledgment is not completion; observe `agent_settled` for settled state. Request IDs correlate responses but are not automatically durable admission deduplication.
3. **Claude:** SDK-managed sessions support structured events and [permission/question callbacks](https://code.claude.com/docs/en/agent-sdk/user-input). Resuming an interactive session's history through a new SDK process is not the same as attaching to the live interactive process. For arbitrary existing Claude terminals, native live takeover remains an integration spike; do not claim it is solved by Herdr or `resume`. A safe initial fallback is an explicit idle/stop-and-resume handoff with one writer, not concurrent processes sharing session files. Hooks can help observation/integration but do not establish a universal live control API by themselves.
4. **Codex:** [app-server](https://developers.openai.com/codex/app-server/) is purpose-built for rich clients: history, events, approvals, and turn steering. Prefer a shared managed app-server for deliberate CLI/native co-presence. The inspected [running-thread resume implementation](https://github.com/openai/codex/blob/e9854c0aa52d494fa4f4c3683741461e2640011b/codex-rs/app-server/src/request_processors/thread_processor.rs#L3918) can delegate resume to an already loaded thread in that server; this is not evidence that a different server can attach to any independent process. The official docs still label WebSocket transport experimental/unsupported. Gate remote/shared use and version-pin the protocol. This adapter is for Mac continuity; cloud model access can still use Pi as requested.

#### Tailscale topology

For personal use, let the future iOS app connect directly to an authenticated Mac bridge over the tailnet. [Tailscale Serve](https://tailscale.com/kb/1312/serve) keeps services tailnet-only; [Funnel](https://tailscale.com/kb/1223/funnel) publishes them to the internet and is not the default needed here.

A normal Cloudflare Worker does not become a tailnet member simply because the Mac and phone are members. Do not assume it can fetch a Mac's MagicDNS name or 100.x address. If all traffic must eventually pass through the cloud API, use an authenticated outbound Mac-to-cloud connection or a deliberately deployed tailnet gateway. Neither is needed for direct phone-to-Mac access.

Tailscale does not keep the Mac awake, restore dead processes, or supply application authorization. Report an asleep/unreachable Mac as such; do not turn that into an idle session or silently run queued destructive input elsewhere.

### Boat integration and lifecycle

Boat is a strong fit as an execution host: real Linux, SSH, Docker/systemd, files, command status/logs and snapshots. Use the [HTTP API](https://docs.boat.dev/api/v1.md) or [SDK](https://docs.boat.dev/sdks/overview.md) from the control plane, not a boat CLI subprocess inside a Worker.

Boat also offers [integrated Pi/Claude/Codex agents](https://docs.boat.dev/platform-guide/agents.md), with structured polled events and parallel conversations. That is a legitimate fast prototype alternative. It introduces Boat-owned conversation orchestration, however. If choosing your own Pi Durable and Claude SDK runtimes, do not also let `boat prompt` independently own those sessions. Use Boat for compute/lifecycle and your runner for managed agents.

The [documented daemon pattern](https://docs.boat.dev/platform-guide/agents.md#bring-your-own-harness-the-daemon-pattern) supports a custom systemd service reachable through a protected HTTPS endpoint. This is the natural home for the Claude runner and, if needed, a task-aware command broker for remote Pi tools. A stable runner endpoint avoids treating per-resume IP addresses as identity.

Critical limits:

- [Stop/snapshot behavior](https://docs.boat.dev/llms.txt): stop is not suspend-to-RAM. Processes end; disk is retained for 14 days by default. A saved snapshot can retain state longer.
- [Snapshot contents](https://docs.boat.dev/snapshots/whats-saved.md): running programs, memory, open ports, `/tmp`, journal logs, and `~/.cache` are not preserved. Store session state in saved locations. Enabled systemd services restart, but their previous process state does not.
- Auto-stop defaults to one hour. Do not assume commands or Herdr activity extend that deadline; documented prompt extension applies to integrated agent prompts. Track active runs and extend/disable auto-stop under an explicit budget policy.
- [Command API](https://docs.boat.dev/long-running-tasks/background-commands.md): synchronous default 30 seconds, maximum 600; detached commands have no command timeout while the VM remains running. Attachment streams reconnect after ten minutes using offsets. Agent restarts can leave final exit codes unknown. Unknown is not success.
- API idempotency keys protect **create and fork** for 24 hours. Do not infer that command POSTs have the same guarantee. Command transport errors can occur after execution begins.

#### Minimum command recovery policy

1. Persist the logical operation ID and intent before dispatch.
2. Record the returned process/runner job identity and output offsets.
3. Reconnect to the same job after control-plane loss; do not launch again just because the HTTP request was retried.
4. If dispatch may have happened but no job ID was durably recorded, reconcile using a runner-owned logical ID where supported. Otherwise surface an uncertain outcome rather than blindly repeating an unsafe command.
5. Bound IDs by workspace and runner boot/generation so a reused PID cannot identify an old operation.
6. Drain/checkpoint agent activity before deliberate stop, or explicitly mark affected runs interrupted and reconcile on resume.

Herdr helps observe/control interactive jobs, but does not remove the remote execution ambiguity. The current remote implementation labels runs for some transport-failure reconciliation; that is not a blanket deduplication guarantee for arbitrary callers and retries.

### Agent-to-agent communication

Use engine-native durable primitives within Pi's Harness, and a small application-level delivery interface across engine/machine boundaries:

- Start/delegate a task with an explicit owner and workspace/worktree policy.
- Send a message with a stable logical delivery ID and requested steer/follow-up behavior.
- Observe/wait for completion; deliver a result through a reporter/outbox mechanism.
- Cancel with explicit foreground/background ownership semantics.

A Pi coordinator can delegate a review to Claude or a registered Mac session without pretending those agents use Pi's transcript. Cross-runtime delivery needs acknowledgments and uncertainty handling; an engine that cannot deduplicate accepted input cannot truthfully provide exactly-once delivery.

Herdr's existing `hc send` workflow remains valuable between interactive terminal agents. Headless Pi Durable and SDK sessions need their structured adapter path; spawning a headless JSON protocol inside a PTY and sending normal terminal text is not equivalent. If a managed session also appears as an hc terminal, explicitly bridge or disable overlapping Herdr notes so messages are not delivered twice.

Use one worktree per concurrently editing agent by default. A shared VM is not permission isolation, and separate model conversations do not prevent concurrent file edits or Git index conflicts.

### Server-first API scope

Keep the first public surface small:

- Create/list/get sessions; bind each to engine and execution target.
- Submit a message with caller operation ID; receipt means admission, not completion.
- Fetch a current snapshot and paginated history.
- Stream native-UI events over SSE, including authoritative snapshot/reset on reconnect.
- Interrupt/cancel supported work and answer a specific approval/question.
- Observe/start/stop/resume the assigned cloud workspace where required.

Return capabilities per adapter instead of claiming identical controls everywhere. Keep model changes within an engine separate from a cross-engine handoff; Pi-to-Claude-SDK is not a simple `setModel` call. An application thread can link several engine sessions and explicit handoff notes.

For event transport, do not reuse Herdr's process-local event sequence as a globally durable SSE cursor. Use an application-owned cursor/epoch where replay is promised, or explicitly resnapshot. Pi's committed transcript can remain authoritative instead of duplicating it wholesale in another transcript database.

Persist approval records bound to engine session, run/generation, tool-call ID, and arguments. An application record does not keep a Claude callback alive across runner death; stale callbacks must be invalidated/reconciled. In Pi Durable, `beforeTool` returning `block` is a failed tool result, not automatically a durable pending-approval queue. Long approval waits must be implemented with durable task/state transitions, not merely a Promise retained in memory.

### Build order

1. **One cloud Pi vertical slice.** Authenticated Hono API, Thread DO/PiHarness, one server-provisioned Boat sandbox per session ([Workspaces](#workspaces)), Anthropic API key ([Model authentication](#model-authentication)), file/shell tools, snapshot/SSE, explicit cancellation. First verify unknown remote command outcomes and lost-receipt retries. No custom Computer filesystem layer is needed if Boat is the filesystem.
2. **Claude runner.** Official SDK on Boat, explicit session IDs, native events, approvals, runner operation receipts, client-initiated official sign-in (supported handoff to be verified), manual `setup-token` fallback, auth-expiration handling, systemd startup and transcript retention/backups.
3. **Durable delegation.** Adapt the Pi background-subagent example; add cross-engine delegation through the runner. Reuse ownership/reporters rather than creating a second generic scheduler.
4. **Mac server/bridge.** Herdr discovery/status plus Pi extension bridge first. Then managed Claude and Codex adapters. Validate arbitrary existing Claude-session takeover separately.
5. **Clients and MCP later.** Test server contracts with scripts/HTTP clients now. Implement native iOS against the same snapshot/event/approval contract later. Add MCP as another API adapter, not a second orchestration engine.

### Alternative: VM-centered runtime

If full Pi CLI extensions, identical Mac/cloud CLI behavior, and terminal-native mixed-agent collaboration outrank DO-owned durability, put the session host on Boat and use Pi coding-agent SDK/RPC, Claude SDK, and optional Herdr there. The DO then holds control-plane receipts/projections rather than a PiHarness driving those sessions. Pi Durable could also run under Node with SQLite on Boat if durable checkpoints are desired, but it remains a distinct runtime from Pi coding-agent.

This reduces the split between local tools and model execution but makes availability and transcript durability depend on the runner, VM lifecycle, and backups. It is a valid alternative—not something to combine with a second active DO model loop for the same session. For the original durable-cloud design and native UI goal, retain Worker-hosted Pi first and treat CLI parity as a separate Mac adapter requirement.

### Validation gates before calling the server reliable

- Drop the client immediately after admission; retry with the same operation ID and observe one admitted input.
- Crash the DO during a remote command, including after remote launch but before saving its handle; prove no blind re-execution.
- Reconnect snapshot/SSE during a tool call, compaction, and pending approval.
- Restart the Claude runner during generation, command execution, and an approval; verify uncertainty and stale-approval handling.
- Stop/resume Boat; demonstrate which transcripts/files remain, which processes die, and safe reconciliation.
- Drop Tailscale connectivity or sleep the Mac; distinguish unreachable from idle and avoid duplicate sends.
- Edit concurrently in two agent worktrees; verify no unintended shared Git index or credential/template leakage.
- Confirm actual Claude subscription billing/auth mode without a silent API-key fallback.

No code was changed in the reference checkouts, no live VM was provisioned, and no paid model call or upstream test suite was run. Boat was evaluated through first-party documentation; its service implementation was not available for inspection. Claude's closed binary internals were not audited. These limits are especially important for authentication behavior, command crash windows, and native takeover of existing interactive sessions.
