# Next work

Everything still to do on the server, in build order. [`MVP.md`](MVP.md) owns scope and status, and [`AGENTS.md`](AGENTS.md) owns architecture and security rules. Delete items from this file as they land.

| Order | Work                                                                  | Why now                                                             |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| First | [Model error handling](#first-model-error-handling)                   | Our sanitizer breaks Pi's retries and overflow compaction           |
| 1     | [Git and GitHub slice](#1-git-and-github-slice)                       | The agent can't reach private repos or push                         |
| 2     | [Long runs and sandbox lifecycle](#2-long-runs-and-sandbox-lifecycle) | Boat stops sandboxes after 1 h today, even mid-command              |
| 3     | [Rest of the MVP](#3-rest-of-the-mvp)                                 | Compaction, packages and web tools, then the first real coding task |
| Any   | [Known limits](#4-known-limits)                                       | Each has its own trigger, listed below                              |
| Any   | [Architecture cleanup](#5-architecture-cleanup)                       | Two items belong at the start of slice 1                            |

Any test expected to run past 1 hour needs the keep-alive from section 2 first.

## First: model error handling

**Problem:** `server/src/sessions/model-stream.ts` replaces every provider error with "Model request failed". Pi reads that text to classify errors, so the replacement has two effects:

- **No retries:** a 429 or 529 ends the run instead of using Pi's default 3 retries.
- **No overflow compaction:** a "prompt is too long" error ends the run instead of compacting and trying again.

Clients also can't tell a usage limit from a bad key, and `message-state.ts` reports Pi faults and stale inputs as model failures. Running Pi's real classifiers on sample error text confirmed the retry and overflow results. No live provider error has been tested yet.

### Protocol

- [ ] Add a `code` to failed runs: `rate_limited`, `overloaded`, `context_overflow`, `auth`, `billing`, `internal` or `unknown`.
- [ ] Add a `retrying` run state with the error and next attempt time.

### Backend

- [ ] Sort provider errors into those categories using Pi's `isRetryableAssistantError` and `isContextOverflow`, then save a fixed safe message that Pi classifies the same way. Raw provider text stays out of saved data.
- [ ] Use Pi's settled reason and detail in `message-state.ts`, so non-model failures stop reading as model failures.
- [ ] Project `live.generation.retry` to the `retrying` state in snapshots and SSE.

### Tests

- [ ] Run each provider error through a real generation, and check that it retries, compacts or fails as Pi intends.
- [ ] Check the client gets the right `code`, and that no secret or raw provider text reaches saved data or responses.
- [ ] Check whether the Anthropic SDK retries before Pi sees an error, and how that adds to Pi's retries.

## 1. Git and GitHub slice

**Goal:** an agent clones public and private repos, pushes to its own branch and works with pull requests, without any Git credential entering the sandbox.

**The whole GitHub flow gets redesigned when this slice opens.** The [open questions](#open-questions) must be answered before implementation starts. Build order stays protocol and tests, then backend, then routes.

### Start with

- [ ] Add typed store modules, because this slice adds more durable records (see [section 5](#5-architecture-cleanup)).
- [ ] Move upstream response schemas beside their adapters, so GitHub's don't join Boat's in `protocol/`.

### PAT management

- [ ] Add authenticated, write-only PAT routes to the `Credentials` DO: set, inspect metadata and delete. No route returns the token.
- [ ] Keep the PAT out of Thread and Pi records, sandboxes, logs and client responses.
- [ ] Decide and document the fine-grained permissions the PAT needs.

### Git identity

- [ ] Resolve identity in the Worker: `GET /user`, then the primary address from `GET /user/emails`. Fall back to `<id>+<login>@users.noreply.github.com`.
- [ ] Set `user.name` and `user.email` in every checkout. The application never invents an identity.

### Clone

- [ ] Support sessions with no repo, and several repos cloned at any time.
- [ ] Clone public repos anonymously over HTTPS.
- [ ] Clone private repos through the Worker Git proxy.
- [ ] Track each session's repo inventory and optional base repo in session metadata. The base is context and grants no access.

### Git proxy and restricted push

- [ ] Point `origin` at a Worker route using an expiring, per-session capability token.
- [ ] Forward Git smart-HTTP to GitHub with the PAT resolved in the Worker.
- [ ] Allow fetches only for repos authorized for that session.
- [ ] Allow pushes only to `cloud-swe/<sessionId>` in an authorized repo, never `main` or another branch.
- [ ] Reject other upstream URLs and redirects.

### PR tools

Bring these over from the original `cloud-swe`, then adapt them to the redesigned flow. They run in the Worker, so the PAT stays out of the sandbox.

| Tool                                  | Purpose                 |
| ------------------------------------- | ----------------------- |
| `git_push`                            | Push the session branch |
| `github_pr_create`                    | Open a PR               |
| `github_pr_update`                    | Edit a PR               |
| `github_pr_close`, `github_pr_reopen` | Change PR state         |
| `github_pr_comment`                   | Comment on a PR         |
| `github_pr_read`                      | Read PR details         |
| `github_pr_merge`                     | Merge a PR              |

Reference code in `~/Developer/cloud-swe`:

- `apps/runner/src/git-tools.ts`: tool definitions
- `packages/api/src/routers/git-broker.ts`: broker routes and decisions
- `docs/github-broker.md`: configuration, transport and validation

The original uses a GitHub App, bundle staging and push approvals. Those are deferred unless the redesign brings them back.

### Open questions

- Do pushes or merges need approval? Should `github_pr_merge` exist at all?
- Is one fixed `cloud-swe/<sessionId>` branch per repo enough, or can an agent create several?
- How is a capability token renewed when it expires during a long run, or when a sandbox resumes?
- How does a repo become authorized for a session?
- Are the PR tools native Pi tools, codemode tools or both?

### Tests

- [ ] Private clone and push succeed, and the PAT never appears in the sandbox.
- [ ] Pushes to `main`, another branch or an unauthorized repo are rejected.
- [ ] Expired tokens, redirects and foreign URLs are rejected.
- [ ] A lost receipt on a PR create can't open a second PR.

## 2. Long runs and sandbox lifecycle

**Rule:** a thread has no token, turn or wall-clock cap. Concurrency across threads is the only enforced limit.

**Problem:** Boat's auto-stop counts from create or resume and ignores activity, so a sandbox stops after 1 h even mid-command. We don't set `ttlSeconds`, so every sandbox gets that default.

### Keep runs alive

- [ ] While a run is active, renew the deadline every few minutes with `update({ ttlSeconds })`.
- [ ] Stop renewing when the run ends, so Boat stops the sandbox and billing ends.
- [ ] Set `ttlSeconds` again on resume and fork. A fork otherwise gets 1 h.

### Resume

- [ ] Resume a stopped sandbox when a message arrives, and report `starting` until it's ready.
- [ ] Reconcile open commands before admitting new work.
- [ ] Handle `409 snapshot_data_expired` after Boat's 14-day retention.

### Remove the time limit

- [ ] Remove the 600 s `bash` limit from `server/src/tools/runner.ts`, `commands.ts`, `registry.ts` and `protocol/src/tools.ts`. The model can still set its own timeout.
- [ ] Make the poll deadline in `commands.ts` apply only when a timeout was set, and rely on the heartbeat to detect dead commands.

### Report the truth

- [ ] When a sandbox stops mid-run, tell the agent its command was interrupted instead of leaving the session `uncertain`.
- [ ] Update `workspace.state` so clients can see stopped and deleted sandboxes.

### Limits and cleanup

- [ ] Enforce `MAX_SANDBOXES`, the only product limit.
- [ ] Add the delete alarm after `SANDBOX_DELETE_AFTER_DAYS` (7) without activity.

### Prove it

Paid tests need explicit approval.

- [ ] Run a command for over an hour on live Boat, about $0.04 per sandbox hour.
- [ ] Restart the Thread during that command. This is the main unknown: Cloudflare alarms have a 15-minute wall-time limit, and nothing has been tested past a few minutes.
- [ ] Check whether a very long single model response hits a platform limit.
- [ ] Stop and resume a sandbox mid-run, and confirm files survive and the session recovers.

## 3. Rest of the MVP

- [ ] Verify Pi's automatic compaction, expose progress and test long-context recovery.
- [ ] Evaluate all six Pi packages and FFF, and record reuse, adapters and blockers.
- [ ] Add web search and page fetching, with credentials kept server-side.
- [ ] Run a real end-to-end task: clone, edit, test, push, plus lost receipts, restart and cancellation. **Paid, needs explicit approval.**

## 4. Known limits

| Limit                                           | Effect                                                                                                             | Resolve                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Stopped sandbox keeps its command `uncertain`   | Blocks the session with `409 busy`. The reconcile job retries every 5 s until Boat deletes the disk, up to 14 days | Section 2                                                   |
| Stale `workspace.state`                         | Clients can't see a stopped sandbox                                                                                | Section 2                                                   |
| `NativeContent.parse` throws on unknown content | Snapshots and history containing that entry may fail, breaking the session's view. Not yet tested                  | Before a Pi upgrade or V1 image attachments                 |
| A killed supervisor can leave its child running | The command ends as `lost` with a warning, but the agent could rerun it beside the old one                         | Process groups help on a clean stop. Leave until it happens |
| No restart test for the reconcile job           | Its survival is unproven. If it fails, orphans wait for the next message, and admission then tries to clear them   | Add with section 2 tests                                    |
| SSE disconnects may log an error                | Log noise that could hide real failures. Not yet confirmed                                                         | Check during the first live run                             |

## 5. Architecture cleanup

| Cleanup                         | Problem today                                                    | When                                                       |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Typed store modules             | Done: `sessions/{thread,catalog}-store.ts`, `command-records.ts` | Done                                                       |
| Schemas beside adapters         | Done: `workspaces/{boat,docker}-schemas.ts`                      | Done                                                       |
| HTTP out of domain code         | `messages.ts` and others return `Response` objects directly      | When a non-route caller appears, such as MCP or delegation |
| Direct Worker-to-Thread routing | All session traffic goes through the single `SessionCatalog`     | When parallel sessions show contention                     |
| Shared test harness             | Tests repeat their setup                                         | When it slows new tests                                    |
