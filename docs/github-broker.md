# GitHub broker configuration and API

The single backend server brokers the signed-in user’s GitHub App user token. Better Auth retrieves and refreshes the token server-side. Concurrent refresh requests for one user share an in-flight promise. Newly stored OAuth tokens are encrypted by Better Auth; its native reader accepts previously stored plaintext tokens.

## Configuration

| Variable                    | Meaning                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GIT_BROKER_URL`            | Server origin reachable from the runner and sandbox; HTTPS required except localhost. See [Git broker proxy](git-broker-proxy.md) |
| `GIT_BROKER_SECRET`         | At least 32 characters; shared only by backend and runner                                                                         |
| `GIT_BROKER_STORAGE`        | Persistent backend directory for uploaded bundles and bare repositories                                                           |
| `GIT_BROKER_MAX_BYTES`      | Per-operation staging and transport limit; defaults to 4 GiB                                                                      |
| `GIT_BROKER_MIN_FREE_BYTES` | Backend free-space floor; defaults to 2 GiB                                                                                       |

The server requires URL, secret, and storage together for capability transport and writes. GitHub metadata reads and onboarding register independently through the existing GitHub client, so they work without bundle storage or a public tunnel. With transport disabled, anonymous public clone remains available and elevated tools are absent. The broker URL is an origin, without a path prefix. Git must be installed on the server. The Linux sandbox needs the existing Git/Python/shell utilities plus curl for bundle uploads. Docker’s isolated scripted sandbox does not acquire network access from this configuration.

The GitHub App needs Account **Email addresses: read** for login, Repository **Contents: read/write** for clone/fetch/push/merge, **Pull requests: read/write** for the PR lifecycle, and **Checks: read** for check runs. GitHub may require **Workflows: write** for pushes that edit workflow files; grant that only if that capability is intended. Repository installations and the user’s own access jointly determine visible repositories and permitted operations. Repository protections still apply.

Migration `0012_git_approvals.sql` adds Git operations and approval wait timing. Deploy database changes before enabling the server, runner, and dispatcher. Existing workflow histories are not a compatibility target for this release. Persistent staging must remain on the same server across restarts.

## Authenticated read routes

| Route                                                       | Response                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/github/installations?page=1`                      | `{ items, nextPage }` for this App's non-suspended user-visible installations    |
| `GET /api/github/repositories?installationId=123&page=1`    | `{ items, nextPage }` for that installation's readable repositories              |
| `GET /api/github/repositories/:owner/:repo/branches?page=1` | `{ items, nextPage }`, after checking repository access                          |
| `GET /api/github/repositories/:owner/:repo/tree?ref=main`   | `{ sha, paths, truncated }`, blob paths cached by commit SHA after access checks |
| `GET /api/github/repositories/:owner/:repo/skills?ref=main` | `{ skills }`, repository skill metadata plus image globals                       |
| `GET /api/skills`                                           | `{ skills }`, global skills shipped in the image                                 |
| `GET /api/threads/:id/git-operations?page=1`                | Up to 50 operations, newest first                                                |
| `GET /api/threads/:id/git-operations/:operationId`          | One owned operation, including proposal, digest, states, expiry, and result      |

Repository and branch pages contain up to 50 entries. `nextPage` is null when the upstream page contains fewer than 50 entries. All routes require a database-validated Better Auth session. None requires approval. The product picker loads each installation's first page in parallel, then continues one installation at a time.

Set server-only `GITHUB_APP_SLUG` to construct the installation URL and verify App identity. Readiness pages `/user/installations` and installation repositories using the user's refreshed GitHub App token. It rejects suspended and foreign installations and requires readable repository access. A pending organization approval is not an active installation. Pagination exhaustion or upstream failure is retryable, not a revocation. Confirmed absence clears onboarding without cancelling already-running work. See [onboarding and browser sessions](backend-contract.md#onboarding-and-browser-sessions).

## Decisions

`POST /api/threads/:id/git-operations/:operationId/decision` accepts:

```json
{ "decision": "approve", "digest": "the proposal's SHA-256 digest" }
```

`decision` is `approve` or `reject`. The route requires thread ownership, an allowed `Origin`, `X-CSRF-Protection: 1`, and `Content-Type: application/json`. Approval expires 24 hours after proposal publication. A matching repeated decision returns the operation; a conflicting decision fails. Approval is separate from execution: `approved` does not mean the remote write succeeded.

SSE publishes `git.approval.requested`, `git.approval.decided`, and `git.operation.updated`. Read the stored proposal before deciding. Push proposals identify an exact commit and expected destination SHA. PR proposals include exact text and, where relevant, head SHA and base branch. Creation and comment bodies include an approved HTML operation marker for reconciliation.

## Read transport and writes

The sandbox receives a 15-minute read capability tied to its current run owner and workspace generation. Ownership resolves the user and repository server-side. The capability grants only ref discovery and upload-pack through `/git/read/*`. The broker rejects receive-pack, arbitrary upstream URLs, and redirects. Repository access is checked on each request. The runner refreshes routing before resumed execution and before tools when access is nearing expiry.

Repository-specific Git configuration maps the canonical GitHub origin through the proxy. Upstream GitHub credentials never enter guest configuration, commands, checkpoints, tool output, or logs. Guest capabilities cannot approve or execute writes.

`git_push` resolves a commit and exports its history through a coordinated command. Shallow repositories fetch complete history within existing limits. A five-minute, single-use upload capability grants access only to that operation’s staging directory. The server imports the bundle into a fresh bare repository with hooks and external Git configuration disabled. It never checks out repository contents. Object verification and fast-forward ancestry checks precede approval.

The server stores the bundle hash, commit, destination lease, and reviewable diff. The first release rejects diff previews larger than 64 KiB. It reserves free space for concurrent staging operations, enforces per-operation size limits, and kills Git process groups on timeout or resource exhaustion. The guest export also has size, free-space, and process-group timeout guards. Staging cleanup runs every minute after settlement or expiry; executing and unknown operations retain their staging. Missing or corrupted staging invalidates a push.

Approved pushes use an explicit destination lease. A changed destination requires another proposal. PR merges use GitHub’s expected-head SHA and requested merge method. The broker checks the named base before dispatch; GitHub does not expose an atomic base-branch lock for approval, and repository protections remain authoritative.

A dispatch claim is persisted before a write. After a lost response, retries reconcile refs, PR state, or operation markers rather than dispatching again. The server retries reconciliation every minute for unsettled writes, including writes from cancelled or terminal runs. This recovery path cannot dispatch a new write. If reconciliation cannot confirm the outcome, execution remains `unknown`; other writes to the same repository are blocked. Do not repeat an unknown operation manually without establishing its remote outcome.

## Scope and validation

Approvals apply only to GitHub writes. Read tools, repository/branch listing, clone/fetch, and ordinary local workspace commands do not require approval. Local commits, rebases, and merges remain available through `bash`. A pending write proposal pauses that run at the tool boundary until its decision is available.

Approval cards show what approving will do and send the stored digest with an explicit Approve or Deny decision. Pushes and PR creations carry a broker-computed `impact`, rendered exactly like the manual dialogs: the destination branch, whether it is new, commit and file counts, a force-push warning with the number of remote commits it replaces, and for a PR the merge direction, how far the base has moved and any conflicting paths. Other operations describe their effect in one line. Unknown outcomes warn against manual retries. Tags and non-GitHub providers remain outside this release. Service-provided credentials enforce the broker path. Blocking separately supplied credentials would require additional network controls.

The [named Cloudflare tunnel runbook](cloudflare-git-broker-tunnel.md) documents a separately authorized deployment step; this migration does not provision DNS/tunnels or edit an actual `.env` file.

Local checks use disposable PostgreSQL, Temporal, Docker backend tests, and a local Git smart HTTP fixture. They do not certify live GitHub App installations or paid Modal behavior. Live GitHub writes and paid provider tests require separate authorization.

Composer tree reads resolve branches to commits before caching. Truncated recursive trees fall back to at most 256 nonrecursive tree reads and 100,000 entries; remaining truncation is explicit in the response. Upstream tree responses are capped at 8 MiB. Skill metadata reads use YAML frontmatter, project name precedence, at most 200 candidates, 64 KiB per file and one MiB total. Caches retain at most 32 commit catalogs per server process and recheck repository access before use.

## Additional PR operations

`github_pr_ready { number }` proposes GitHub's `markPullRequestReadyForReview` mutation. Recovery reads the draft state. `github_pr_review_reply { number, commentId, body }` replies to an inline review comment with the approved operation marker. Recovery searches PR review comments for that exact marked body. `github_pr_review_resolve { threadId }` verifies the thread belongs to the repository before proposing `resolveReviewThread`; recovery reads its resolved state. Each operation uses the existing approval, dispatch claim, and reconciliation path. GraphQL errors leave dispatched outcomes unknown.

`github_pr_read { action: "review_threads", number, cursor? }` returns thread IDs, paths, lines, resolved state, comments and pagination cursors. Each page contains at most 50 threads with the first 100 comments per thread, including a continuation indicator.

`git_push` accepts optional `force: true`. It skips only the ancestry check, records the number of remote commits absent from the proposed commit, and retains the explicit destination lease. The broker refuses the repository's current default branch both at preparation and before dispatch. The approval card displays the overwrite count and a force-push warning.

## Push and PR impact

Push preparation measures the uploaded bundle against the destination. An existing branch is compared with its current head; a new branch is compared with its merge base on the thread's base branch, which is fetched into the same staging repository. The proposal preview is the `--stat` summary only, bounded to 60,000 characters, so a large first push no longer fails the preview limit. PR previews fetch the base, and the head when no bundle supplies it, as a `blob:none` partial clone with the owner's token, then run `git merge-tree --write-tree --name-only`. Only blobs that differ are downloaded. At most 200 conflicting paths are listed. An agent PR proposal whose preview fails still publishes, and its card then shows only the branches; it never claims a clean merge.

## Thread PR status

`GET /api/threads/:id/pull-request` resolves the successful PR creation, or a successful operation on an existing PR, reads its current PR/checks with the owner's token, and saves the summary on the thread. Migration `0026_thread_pull_request.sql` adds that cache. The open thread refreshes every 30 seconds; the sidebar reads only PostgreSQL. Draft, open, closed and merged icons are gray, green, red and purple. No webhooks are installed.

## Manual push and PR actions

`GET /api/threads/:id/manual-git` decides which header actions appear, from the sandbox's latest diff report (branch, `HEAD`, dirty, changes against the base) and GitHub (the remote head of that branch and any open PR from it). Push appears when the tree is dirty or the remote head differs; Open PR appears when the branch differs from the base, has changes, and has no open PR. Both are disabled while an agent run, a lifecycle transition or an unsettled command is in progress. A new diff report or Git event refreshes the state.

Opening either dialog submits `POST …/manual-git/check { clientMessageId, action }`. The check run snapshots the checkout from a private index without moving any ref, records a fingerprint of every changed file, uploads the snapshot as a bundle and asks the broker's internal `check` route for the push impact and, for a PR, the merge preview against the thread's base. The result is saved as the `manual-git-check` checkpoint and read through `GET …/manual-git/:runId`. The dialog meanwhile shows empty fields; anything left blank is written by the utility model at confirmation, and anything typed is kept verbatim.

`POST …/manual-git/confirm { clientMessageId, checkRunId, commitMessage?, title?, body? }` fills only the blank fields, then submits a `push` or `pr` run. That run commits all current changes when the tree was dirty, refusing if the fingerprint changed, then proposes the push with the checked force flag. The push must see the same remote head the check saw, otherwise it stops and asks for another check. Pushing to the default branch with force is refused. A `pr` run then proposes and executes `pr_create` against the checked base, refusing if the check found conflicts. In that case the dialog offers Fix with agent, which sends the agent a prompt to merge the base and resolve the listed files.

The confirmation is the approval. The `manual-git-proposal` checkpoint publishes each proposal as already approved, without an approval card, and the run executes it through the normal dispatch claim and reconciliation path. Refusals fail the run with a user-facing message; transport failures retry. The guest commit atomically updates the branch and a per-run receipt ref, so a retried activity returns the same commit. Manual commits bypass repository hooks. Fingerprinting accepts at most 64 MiB of changed file contents. After every manual run the runner refreshes the diff report, so the header reflects the push.

Text generation uses the same application-owned `claude-haiku-5-5` client as titles, with a 30-second deadline, at most two concurrent requests, and a fallback to commit subjects. It receives the commit subjects, `--stat` and a 16,000-character diff excerpt, and is told to treat them as data.
