# Session API

## Implemented now

- `POST /v1/sessions`: authenticated, strict request validation, configured workspace/model allowlist, durable creation intent and idempotent retries.
- `GET /v1/sessions`: cursor pagination over the personal account index.
- `GET /v1/sessions/:sessionId`: reads the actual persisted Pi root/agent binding and current native run state.
- `POST /v1/sessions/:sessionId/messages`: durable message admission, 202 receipt, same-ID retry recovery, and explicit reject/steer/followUp modes (reject by default).
- `GET /v1/sessions/:sessionId/operations/:operationId`: confirmed message/cancellation admission receipt lookup.
- `POST /v1/sessions/:sessionId/cancel`: idempotent cancellation of a named pending input/run.
- `POST /v1/sessions/:sessionId/approvals/:approvalId`: `{ "decision": "approve" | "reject" }`. The only way a ref update or PR merge runs; idempotent on a repeat, 409 on the opposite decision.
- `POST /v1/sessions/:sessionId/questions/:questionId`: `{ "answers": [...] }` or `{ "decline": true }`. Delivers the answer to `ask_user_question` as one steering message; the first answer wins. A refused delivery is retried by the Thread's delivery job.
- `GET /v1/auth/login`: open in a browser to sign in with GitHub through the GitHub App. Only `GITHUB_ALLOWED_USER_ID` gets a session; it lands on `GET /v1/auth/token`, which shows the bearer token for API clients (`no-store`). Better Auth serves the rest of `/v1/auth/*`, including `POST /v1/auth/sign-out`.
- `/git/:sessionId/github.com/:owner/:repo.git/*`: the Git proxy, authenticated by a per-session capability token (not a signed-in session). Needs `PUBLIC_URL`.

Each app UUID addresses one Thread Durable Object, one real PiHarness, and its native root conversation in DO SQLite. The account catalog is metadata only. PiHarness/Lifecycle manages startup and wake ownership. See [`../protocol/SOURCE-VERIFICATION.md`](../protocol/SOURCE-VERIFICATION.md) for source commits and mappings.

Client credentials: `PUT /v1/credentials/models/anthropic` with `{ "key": "…" }`, `GET` for metadata, and `DELETE` to disable access (including the Worker fallback). Authenticated, write-only, `no-store`; the private account Credentials DO retains keys across restart. Existing Threads resolve keys dynamically. Today the account is `personal`; future per-user routing must use verified server identity. No separate broker deployment.

Environments: `GET /v1/environments`, `PUT`/`DELETE /v1/environments/:name`, and `PUT`/`DELETE` on `/variables/:key` and `/network-secrets/:key` under it. Authenticated and `no-store`. They live in the Credentials DO (`src/environments.ts`), keyed `env:<name>`. Network secrets are write-only; a placeholder `cloudswe_ph_<NAME>_<32 hex>` is minted on first set and kept on update. Only the `sandboxView` and `networkSwaps` RPCs leave the DO with values. Before each fresh `bash` dispatch, `syncSandbox` (`src/sandbox/egress.ts`) writes the session environment's variables and placeholders to `.cloud-swe/env.json` when their hash changed, and the supervisor merges that file into the command's environment. `set_environment_variable` lets the agent set or remove a variable, replay-safe through receipts keyed by its tool call.

**Model-only execution:** message capability is enabled only when the session's model is present in the registered catalog and its account credential or testing fallback is configured. Tool execution remains unimplemented. `GET /v1/sessions/:sessionId/{snapshot,history,events}` project native Pi state; history is paginated oldest-to-newest within each backwards page. Entry IDs are opaque strings scoped to the session. SSE begins with a replacement snapshot, ignores Last-Event-ID, coalesces full snapshots in a single buffer and uses Effect scopes to stop watches/heartbeats on disconnect. Historical entries have nullable app run attribution rather than an invented UUID. Tools remain empty. No model request is made during creation. Pi explicitly registers Anthropic and resolves its API key through a read-only adapter to the private Credentials DO, with ambient environment/file credentials disabled. Missing keys remain unauthenticated; no credentials are persisted in session storage. Message intents reserve a stable app run ID before dispatch and pass the operation ID to Pi. A retry reconciles Pi admission before busy/auth checks. Unresolved admission returns 503 rather than an invented receipt, and blocks new work until the original operation is retried. `mode: "steer"` uses Pi's next boundary (not immediate model interruption); `mode: "followUp"` queues FIFO, with one follow-up consumed per final boundary. Pending steers can be consumed at that same boundary. If idle, either starts normally. At most 100 native inputs may be pending; `Session.pending` exposes their modes and native status.

Each input has its own receipt/app run ID, even when Pi handles several in one generation. Cancellation resolves that ID to the saved native operation, not whichever conversation happens to be active later. Queued cancellation only withdraws that input; active/placed cancellation captures the current pending-input scope and **also withdraws those queued inputs**. The frozen scope cannot grow on retry. Each placed input is resolved to its bound native task in a Pi transaction; task handovers are re-resolved, and settled inputs never cause a conversation-wide abort. The short DO gate covers intent admission only, not waiting for model/tool interruption. Retries are checked before stale-run validation. No API key is needed to cancel already admitted work. The response and operation lookup include `restoredMessages` with queued text for the client editor, matching Pi's interactive Escape (clear/restore queues, then abort). A withdrawn approval result or question answer is not restored; it is written into the conversation as a model-only notice instead. Provider stream errors/throws are replaced with generic messages before Pi checkpoints them. The transcript remains native Pi state, not a parallel application transcript. Other protocol schemas remain proposals for later routes, not native Pi decoders.

## Workspace orchestration

Workspace operations return lazy Effect values, executed at the session-creation boundary. Effect owns in-memory retries, polling, timeouts and abort propagation, not session durability. Hono, Zod contracts, PiHarness and DO persistence are unchanged.

E2B has no idempotency key, so before creating without a recorded sandbox ID the server lists sandboxes by their `cloudSweWorkspace` metadata with a five-second abort-aware deadline. E2B lists running and paused sandboxes, so a complete empty result means none exists. Only a unique match from a complete result is recoverable; ambiguous, truncated or unavailable lookups never trigger a create. Concurrent retries in the catalog share one lookup and create.

A create is one attempt with a 30-second timeout and is not retried automatically. Inspections have a five-second timeout; readiness polls at most 30 times, two seconds apart, with a one-minute overall deadline. These bounds can return 503 while provisioning continues remotely: retry the original operation ID. Aborting transport does not undo a sandbox creation.

Expected workspace failures are typed and sanitized before becoming HTTP 503 responses. `TestClock` covers retry exhaustion, deadlines and interruption without wall-clock sleeps; Docker/Miniflare tests still prove storage/restart behavior. See [`../docs/effect.md`](../docs/effect.md) for the evaluation, measured trade-offs and source examples.

## Tests (Docker by default)

From the repository root:

```sh
pnpm test
```

The command builds Linux images, starts a separate non-root Docker workspace service, and runs all contract tests, TypeScript checks, Worker bundling, and HTTP integration tests inside Docker. Actual workerd/Miniflare executes the Hono Worker and SQLite Durable Objects. PiHarness is not mocked; integration tests inspect `pi_conversations` directly before and after restart. E2B mapping tests replace only the SDK's entry points (not live E2B); Docker adapter tests hit the separate running sandbox. No host workspace mount or Docker socket is given to the sandbox. It stands in for E2B: `PUT /workspaces/:id` creates one isolated directory per app workspace, idempotently, `GET /workspaces/:id` inspects it, and its pause freezes running commands until a resume continues them.

Model tests intercept Anthropic transport in Miniflare (no paid calls) and exercise real Pi generation, concurrent/lost-receipt retries, busy rejection, successful/failed run projection, restart persistence, missing-credential rejection without reservation, and secret-free native entries/tasks/submissions/documents. Native control tests cover steering delivery, FIFO follow-ups, queue bounds, queued/active cancellation, cross-action conflicts, stale cancellation and restart-safe cancellation receipts.

Integration tests cover unauthorized and malformed requests, body limits, model/template allowlists, one sandbox per session, actual session creation, lost-receipt/concurrent retries, conflicting intents, pagination, unknown IDs, unavailable workspace, and full workerd restart with the same SQLite storage. Temporary test state and Compose containers are cleaned up.

### Opt in to E2B

```bash
pnpm --filter server e2b:template # once per account, and after changing the recipe
pnpm test --e2b
```

All tests still execute inside Docker, and those written for E2B provision real sandboxes: `server/test/e2b-live.test.ts`, and the creation paths in `server/test/sessions.test.ts`. **This bills sandbox time**, at cents a run. They delete every sandbox they created, found by its `cloudSweWorkspace` metadata. The flag fails before starting if `E2B_API_KEY` is absent. The model is scripted, so there are no paid model calls.

## GitHub App

Register one at <https://github.com/settings/apps/new>, then install it on the repositories agents may use. Those are the outer bound; a clone of any other repo goes anonymously.

- Callback URL: `$PUBLIC_URL/v1/auth/callback/github`. Leave "Request user authorization during installation" off.
- Webhook: off. Where it can be installed: only this account.
- Repository permissions: Contents read/write, Pull requests read/write, Checks read, Metadata read (mandatory). Workflows read/write only if agents must edit `.github/workflows`.
- Account permissions: none. Commits, PRs and comments show as the app bot, and commits credit the signed-in account with a `Co-authored-by` line.

## Running/deploying the API

Use `pnpm dev` for Wrangler or `pnpm --filter server deploy` for deployment. Configure the following bindings in the root `.env` locally (copy `.env.example`; `pnpm dev` loads it with `--env-file`) and Wrangler secrets/configuration in production (nothing defaults to a development secret):

| Binding                                            | Meaning                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                               | Signs sign-in sessions                                                           |
| `GITHUB_ALLOWED_USER_ID`                           | Numeric ID of the only GitHub account allowed in                                 |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | The GitHub App's OAuth credentials, for sign-in                                  |
| `GITHUB_APP_PRIVATE_KEY`                           | The GitHub App's private key as PKCS#8 PEM, for installation tokens              |
| `PUBLIC_URL`                                       | This Worker's base URL, for the sign-in callback and the Git proxy               |
| `WORKSPACE_TEMPLATES`                              | Comma-separated E2B template names sessions may request                          |
| `WORKSPACE_BACKEND`                                | `e2b`; `docker` only inside `pnpm test` (explicit, no silent fallback)           |
| `MODEL_PROVIDER`, `MODEL_ID`                       | Single permitted model selector (Anthropic)                                      |
| `DOCKER_SANDBOX_URL`, `DOCKER_SANDBOX_TOKEN`       | Docker provisioning test double, reachable from the Worker                       |
| `ANTHROPIC_API_KEY`                                | Optional test fallback; overridden by client keys or an explicit disabled marker |
| `E2B_API_KEY`                                      | E2B account key; the server creates one sandbox per session                      |

Tests inject these bindings directly; they do not read `.env`. A deployed Worker cannot reach your laptop's Docker Compose DNS. Use E2B for cloud deployment. Do not expose the local Docker service publicly or point the deployed Worker at localhost.

Example request (once configured, with the token from `/v1/auth/token`):

```sh
curl "$API_URL/v1/sessions" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"operationId":"e82d700b-576c-4d17-b2f5-ef33ca24c5e3","template":"base","model":{"provider":"anthropic","id":"configured-model"}}'
```

Generate the operation ID once and keep it for retries. First creation returns 201; identical retries return 200 and the same application/native session. Different intent under the same ID returns 409. No credentials appear in request bodies, session records, or responses.

This is deliberately a single personal principal, not multi-user tenancy. Signing in again keeps the same personal catalog. Creation intents persist before opening Pi; a crash after Pi opens but before indexing is repaired by retrying the original operation ID, targeting the same Thread/root.
