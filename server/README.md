# Session API

## Implemented now

- `POST /v1/sessions`: authenticated, strict request validation, configured workspace/model allowlist, durable creation intent and idempotent retries.
- `GET /v1/sessions`: cursor pagination over the personal account index.
- `GET /v1/sessions/:sessionId`: reads the actual persisted Pi root/agent binding.

Each app UUID addresses one Thread Durable Object, one real PiHarness, and its native root conversation in DO SQLite. The account catalog is metadata only. PiHarness/Lifecycle manages startup and wake ownership. See [`../protocol/SOURCE-VERIFICATION.md`](../protocol/SOURCE-VERIFICATION.md) for source commits and mappings.

**Not a runnable agent yet:** capabilities are disabled. Message, cancellation, tool execution, snapshot/history/SSE routes remain unimplemented and return 404. No model request is made during creation; the configured model selector is persisted but no provider credentials are installed. The other protocol schemas remain design proposals for those later routes, not native Pi decoders.

## Workspace orchestration

Workspace operations return lazy Effect values, executed at the session-creation boundary. Effect owns in-memory retries, polling, timeouts and abort propagation, not session durability. Hono, Zod contracts, PiHarness and DO persistence are unchanged.

Boat creates retry only an exact `409 idempotency_in_progress` error code: at most ten attempts, one second apart, with the same body/key. Other errors are not automatically retried. Each create request has a 30-second timeout and the entire create/retry sequence has a two-minute deadline. Inspections have a five-second timeout; readiness polls at most 30 times, two seconds apart, with a one-minute overall deadline. These bounds can return 503 while provisioning continues remotely: retry the original operation ID. Aborting transport does not undo a sandbox creation.

Expected workspace failures are typed and sanitized before becoming HTTP 503 responses. `TestClock` covers retry exhaustion, deadlines and interruption without wall-clock sleeps; Docker/Miniflare tests still prove storage/restart behavior. See [`../EFFECT.md`](../EFFECT.md) for the evaluation, measured trade-offs and source examples.

## Tests (Docker by default)

From the repository root:

```sh
pnpm test
```

The command builds Linux images, starts a separate non-root Docker workspace service, and runs all contract tests, TypeScript checks, Worker bundling, and HTTP integration tests inside Docker. Actual workerd/Miniflare executes the Hono Worker and SQLite Durable Objects. PiHarness is not mocked; integration tests inspect `pi_conversations` directly before and after restart. Boat SDK state-mapping tests mock only its HTTP transport (not live Boat); Docker adapter tests hit the separate running sandbox. No host workspace mount or Docker socket is given to the sandbox. It stands in for Boat provisioning: `PUT /workspaces/:id` creates one isolated directory per app workspace, idempotently, and `GET /workspaces/:id` inspects it. It does not implement shell/file tools yet.

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
| `MODEL_PROVIDER`, `MODEL_ID`                 | Single permitted model selector, not a working provider installation yet  |
| `DOCKER_SANDBOX_URL`, `DOCKER_SANDBOX_TOKEN` | Docker provisioning test double, reachable from the Worker                |
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
