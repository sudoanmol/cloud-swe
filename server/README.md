# Session API

## Implemented now

- `POST /v1/sessions`: authenticated, strict request validation, configured workspace/model allowlist, durable creation intent and idempotent retries.
- `GET /v1/sessions`: cursor pagination over the personal account index.
- `GET /v1/sessions/:sessionId`: reads the actual persisted Pi root/agent binding and current native run state.
- `POST /v1/sessions/:sessionId/messages`: durable message admission, 202 receipt, same-ID retry recovery, and explicit reject/steer/followUp modes (reject by default).
- `GET /v1/sessions/:sessionId/operations/:operationId`: confirmed message/cancellation admission receipt lookup.
- `POST /v1/sessions/:sessionId/cancel`: idempotent cancellation of a named pending input/run.

Each app UUID addresses one Thread Durable Object, one real PiHarness, and its native root conversation in DO SQLite. The account catalog is metadata only. PiHarness/Lifecycle manages startup and wake ownership. See [`../protocol/SOURCE-VERIFICATION.md`](../protocol/SOURCE-VERIFICATION.md) for source commits and mappings.

**Model-only execution:** message capability is enabled only when the session's model is present in the registered catalog and its Worker credential is configured. Tool execution and snapshot/history/SSE routes remain unimplemented. Tools remain empty. No model request is made during creation. Pi explicitly registers Anthropic and resolves its API key through a read-only Worker-secret credential store, with ambient environment/file credentials disabled. Missing keys remain unauthenticated; no credentials are persisted in session storage. Message intents reserve a stable app run ID before dispatch and pass the operation ID to Pi. A retry reconciles Pi admission before busy/auth checks. Unresolved admission returns 503 rather than an invented receipt, and blocks new work until the original operation is retried. `mode: "steer"` uses Pi's next boundary (not immediate model interruption); `mode: "followUp"` queues FIFO, with one follow-up consumed per final boundary. Pending steers can be consumed at that same boundary. If idle, either starts normally. At most 100 native inputs may be pending; `Session.pending` exposes their modes and native status.

Each input has its own receipt/app run ID, even when Pi handles several in one generation. Cancellation resolves that ID to the saved native operation, not whichever conversation happens to be active later. Queued cancellation only withdraws that input; active/placed cancellation captures the current pending-input scope and **also withdraws those queued inputs**. The frozen scope cannot grow on retry. Each placed input is resolved to its bound native task in a Pi transaction; task handovers are re-resolved, and settled inputs never cause a conversation-wide abort. The short DO gate covers intent admission only, not waiting for model/tool interruption. Retries are checked before stale-run validation. No API key is needed to cancel already admitted work. Provider stream errors/throws are replaced with generic messages before Pi checkpoints them. The transcript remains native Pi state, not a parallel application transcript. Other protocol schemas remain proposals for later routes, not native Pi decoders.

## Workspace orchestration

Workspace operations return lazy Effect values, executed at the session-creation boundary. Effect owns in-memory retries, polling, timeouts and abort propagation, not session durability. Hono, Zod contracts, PiHarness and DO persistence are unchanged.

Before creating without a recorded Boat sandbox ID, the server looks up the stable `cloud-swe-<workspaceId>` name with a five-second abort-aware deadline. Only a unique exact match from a complete result is recoverable; malformed, ambiguous, truncated or unavailable lookups never trigger a create. Existing sandboxes can be recovered beyond the 23-hour idempotency retry margin; absent ones beyond it return an unknown-outcome 503 without creating.

Boat creates retry only an exact `409 idempotency_in_progress` error code: at most ten attempts, one second apart, with the same body/key. Other errors are not automatically retried. Each create request has a 30-second timeout and the entire create/retry sequence has a two-minute deadline. Inspections have a five-second timeout; readiness polls at most 30 times, two seconds apart, with a one-minute overall deadline. These bounds can return 503 while provisioning continues remotely: retry the original operation ID. Aborting transport does not undo a sandbox creation.

Expected workspace failures are typed and sanitized before becoming HTTP 503 responses. `TestClock` covers retry exhaustion, deadlines and interruption without wall-clock sleeps; Docker/Miniflare tests still prove storage/restart behavior. See [`../EFFECT.md`](../EFFECT.md) for the evaluation, measured trade-offs and source examples.

## Tests (Docker by default)

From the repository root:

```sh
pnpm test
```

The command builds Linux images, starts a separate non-root Docker workspace service, and runs all contract tests, TypeScript checks, Worker bundling, and HTTP integration tests inside Docker. Actual workerd/Miniflare executes the Hono Worker and SQLite Durable Objects. PiHarness is not mocked; integration tests inspect `pi_conversations` directly before and after restart. Boat SDK state-mapping tests mock only its HTTP transport (not live Boat); Docker adapter tests hit the separate running sandbox. No host workspace mount or Docker socket is given to the sandbox. It stands in for Boat provisioning: `PUT /workspaces/:id` creates one isolated directory per app workspace, idempotently, and `GET /workspaces/:id` inspects it. It does not implement shell/file tools yet.

Model tests intercept Anthropic transport in Miniflare (no paid calls) and exercise real Pi generation, concurrent/lost-receipt retries, busy rejection, successful/failed run projection, restart persistence, missing-credential rejection without reservation, and secret-free native entries/tasks/submissions/documents. Native control tests cover steering delivery, FIFO follow-ups, queue bounds, queued/active cancellation, cross-action conflicts, stale cancellation and restart-safe cancellation receipts.

Integration tests cover unauthorized and malformed requests, body limits, model/environment allowlists, one sandbox per session, actual session creation, lost-receipt/concurrent retries, conflicting intents, pagination, unknown IDs, unavailable workspace, and full workerd restart with the same SQLite storage. Temporary test state and Compose containers are cleaned up.

### Opt in to Boat

```sh
export BOAT_API_KEY=...  # set privately; never commit it
pnpm test --boat
```

All tests still execute inside Docker, but session creation provisions real `default`-size Boat sandboxes from the `base` environment through `@boatdev/sdk`. **This bills sandbox time.** The suite deletes every sandbox it created, found by its `cloud-swe-<workspaceId>` name. The flag fails before starting if `BOAT_API_KEY` is absent. No fallback to Docker and no paid model/command calls.

## Running/deploying the API

Use `pnpm dev` for Wrangler or `pnpm --filter server deploy` for deployment. Configure the following bindings in the root `.env` locally (copy `.env.example`; `pnpm dev` loads it with `--env-file`) and Wrangler secrets/configuration in production (nothing defaults to a development auth token):

| Binding                                      | Meaning                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `API_TOKEN`                                  | Your personal API bearer token; separate from provider/Boat keys          |
| `WORKSPACE_ENVIRONMENTS`                     | Comma-separated Boat environment names sessions may request (e.g. `base`) |
| `WORKSPACE_BACKEND`                          | `docker` or `boat` (explicit, no silent fallback)                         |
| `MODEL_PROVIDER`, `MODEL_ID`                 | Single permitted model selector (Anthropic)                               |
| `DOCKER_SANDBOX_URL`, `DOCKER_SANDBOX_TOKEN` | Docker provisioning test double, reachable from the Worker                |
| `ANTHROPIC_API_KEY`                          | Anthropic API key for Pi in the Thread DO; never sent to a sandbox        |
| `BOAT_API_KEY`                               | Boat account key; the server creates one sandbox per session              |

Tests inject these bindings directly; they do not read `.env`. A deployed Worker cannot reach your laptop's Docker Compose DNS. Use Boat for cloud deployment. Do not expose the local Docker service publicly or point the deployed Worker at localhost.

Example request (once configured):

```sh
curl "$API_URL/v1/sessions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"operationId":"e82d700b-576c-4d17-b2f5-ef33ca24c5e3","engine":"pi","target":"cloud","environment":"base","model":{"provider":"anthropic","id":"configured-model"}}'
```

Generate the operation ID once and keep it for retries. First creation returns 201; identical retries return 200 and the same application/native session. Different intent under the same ID returns 409. No credentials appear in request bodies, session records, or responses.

This is deliberately a single personal principal, not multi-user tenancy. API token rotation keeps the same personal catalog. Creation intents persist before opening Pi; a crash after Pi opens but before indexing is repaired by retrying the original operation ID, targeting the same Thread/root.
