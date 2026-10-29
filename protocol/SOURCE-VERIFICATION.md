# Pi source verification

Verified against local source checkouts and the installed npm package declarations on 2026-10-29:

- Pi / Pi Durable **1.4.0**, commit `f09d01b85e0384647fcab6779d35ab9dabe04be3`.
- Cloudflare Agents / PiHarness **0.32.0**, commit `be1749221ab3efc8be4e976d8e7d8344d1446032`.

The original `protocol/src/index.ts` was an **application-owned proposal**, not a transcription of Pi types. It must not be used as a decoder for native Pi events/transcripts.

## Verified distinctions

| Application contract | Actual upstream shape | Implemented mapping |
| --- | --- | --- |
| UUID `Session.id` | Pi Durable branded numeric `ConversationId`; PiHarness addresses it as a decimal string; root is `"1"` | One Thread DO per app UUID. `Session.runtime.conversationId` records the native root ID. `getSession()` reads the actual root/agent again. |
| `{ provider, id }` model selector | PiHarness accepts this shape; Pi Durable stores `{ provider, modelId }` | Explicit conversion in `Thread.initialize()`, inverse conversion from `root.agent()` on reads. |
| Proposed `OperationReceipt` with app run ID/timestamp | PiHarness `PiReceipt` is `{ operationId, session, accepted }`; `accepted: false` means duplicate admission | Not implemented/advertised yet. Do not cast one into the other. |
| Proposed message/tool entries with UUID IDs | Native `EntryRecord` IDs are numeric, records immutable; roles/content live in `model`, kind/data preserve Pi semantics | Not implemented/advertised yet. Needs stable app/native ID mapping and explicit projection, including live documents. |
| Proposed `SessionEvent` union | `watch()` gives a bounded view + Chord operations; `watchEvents()` supplies native agent-event batches | Not implemented/advertised yet. Never parse native events with `SessionEvent`. |
| Proposed UUID `RunId` | Native runs/tasks use their own numeric IDs and documents | Not implemented/advertised yet. An app run ID is not a Pi task ID. |

Current capabilities are therefore all disabled and tools are empty. Session creation is real, but creating a session does not execute a model request or install working file/shell tools. The persisted model selector is checked against the host's configured selector; model credentials/catalog/provider installation belongs to the message-execution slice.

## Source paths traced

- [`durable/README.md`](https://github.com/earendil-works/pi/blob/f09d01b85e0384647fcab6779d35ab9dabe04be3/packages/durable/README.md): Harness/storage ownership, root reuse, models, watch/reconnect, admission and recovery semantics.
- [`durable/src/harness/types.ts`](https://github.com/earendil-works/pi/blob/f09d01b85e0384647fcab6779d35ab9dabe04be3/packages/durable/src/harness/types.ts): `ModelRef`, `Conversation`, `AgentChange`.
- [`PiHarness types.ts`](https://github.com/cloudflare/agents/blob/be1749221ab3efc8be4e976d8e7d8344d1446032/packages/agents/src/harness/pi/types.ts): native session addressing, receipt and operation shapes.
- [`PiHarness harness.ts`](https://github.com/cloudflare/agents/blob/be1749221ab3efc8be4e976d8e7d8344d1446032/packages/agents/src/harness/pi/harness.ts): root creation/reuse, `{ id }` → `{ modelId }` conversion, factory context, wake scheduling, session creation, submission deduplication.
- [`Pi example server.ts`](https://github.com/cloudflare/agents/blob/be1749221ab3efc8be4e976d8e7d8344d1446032/examples/next/harnesses/pi/src/server.ts) and [`factory-fixture.ts`](https://github.com/cloudflare/agents/blob/be1749221ab3efc8be4e976d8e7d8344d1446032/packages/agents/src/harness/pi/tests/factory-fixture.ts): `Lifecycle.install(this).use(harness)` and passing `onWake` through to `Harness.open`.
- Installed `agents` lifecycle declaration: native RPC must call `Lifecycle.start()` explicitly (fetch/alarm handlers start it automatically).

## Workspace boundary

Docker stands in for Boat's workspace host, **not** for PiHarness, SQLite, or Cloudflare's runtime. Tests use actual workerd/Miniflare with SQLite DOs inside Docker; a separate non-root Docker service exposes an authenticated writable-workspace readiness probe. No host filesystem or Docker socket is exposed to that service.

Boat mode uses the official `@boatdev/sdk` 1.13.0 npm package (`BoatApi.get`, explicitly configured with platform `fetch` rather than its default Node HTTP/2 transport), backed by the documented [`GET /sandboxes/{sandboxId}`](https://docs.boat.dev/api/reference/sandboxes/get-sandbox.md) endpoint and parses only the consumed subset of its `sandbox.info` envelope. `ready`, `idle`, and `running` mean usable for creation; `degraded` does not. No model-owned Boat agent, automatic provisioning, or paid command dispatch is involved in session creation. Live Boat checks require an explicit flag and credentials.
