# GitHub broker configuration and API

The single backend server brokers the signed-in user’s GitHub App user token. Better Auth retrieves and refreshes the token server-side. Concurrent refresh requests for one user share an in-flight promise. Newly stored OAuth tokens are encrypted by Better Auth; its native reader accepts previously stored plaintext tokens.

## Configuration

| Variable                    | Meaning                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `GIT_BROKER_URL`            | Server origin reachable from the runner and sandbox; HTTPS required except localhost |
| `GIT_BROKER_SECRET`         | At least 32 characters; shared only by backend and runner                            |
| `GIT_BROKER_STORAGE`        | Persistent backend directory for uploaded bundles and bare repositories              |
| `GIT_BROKER_MAX_BYTES`      | Per-operation staging and transport limit; defaults to 4 GiB                         |
| `GIT_BROKER_MIN_FREE_BYTES` | Backend free-space floor; defaults to 2 GiB                                          |

The server requires URL, secret, and storage together. With the broker disabled, anonymous public clone remains available and elevated tools are absent. The broker URL is an origin, without a path prefix. Git must be installed on the server. The Linux sandbox needs the existing Git/Python/shell utilities plus curl for bundle uploads. Docker’s isolated scripted sandbox does not acquire network access from this configuration.

The GitHub App needs Account **Email addresses: read** for login, Repository **Contents: read/write** for clone/fetch/push/merge, **Pull requests: read/write** for the PR lifecycle, and **Checks: read** for check runs. GitHub may require **Workflows: write** for pushes that edit workflow files; grant that only if that capability is intended. Repository installations and the user’s own access jointly determine visible repositories and permitted operations. Repository protections still apply.

Migration `0012_git_approvals.sql` adds Git operations and approval wait timing. Deploy database changes before enabling the server, runner, and dispatcher. Existing workflow histories are not a compatibility target for this release. Persistent staging must remain on the same server across restarts.

## Authenticated read routes

| Route                                                       | Response                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/github/repositories?page=1`                       | `{ items, nextPage }`, including accessible private repositories            |
| `GET /api/github/repositories/:owner/:repo/branches?page=1` | `{ items, nextPage }`, after checking repository access                     |
| `GET /api/threads/:id/git-operations?page=1`                | Up to 50 operations, newest first                                           |
| `GET /api/threads/:id/git-operations/:operationId`          | One owned operation, including proposal, digest, states, expiry, and result |

Repository and branch pages contain up to 50 entries. `nextPage` is null when the page contains fewer than 50 entries. All routes require a Better Auth session. None requires approval.

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

Approvals apply only to GitHub writes. Read tools, repository/branch listing, clone/fetch, and ordinary local workspace commands do not require approval. Local commits, rebases, and merges remain available through `remote_exec`. A pending write proposal pauses that run at the tool boundary until its decision is available.

Frontend approval controls, force pushes, tags, and non-GitHub providers are outside this release. Service-provided credentials enforce the broker path. Blocking separately supplied credentials would require additional network controls.

Local checks use disposable PostgreSQL, Temporal, Docker backend tests, and a local Git smart HTTP fixture. They do not certify live GitHub App installations or paid Freestyle behavior. Live GitHub writes and paid provider tests require separate authorization.
