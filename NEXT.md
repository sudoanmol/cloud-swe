# Next work

Everything still to do on the server, in build order. [`MVP.md`](MVP.md) owns scope and status, and [`AGENTS.md`](AGENTS.md) owns architecture and security rules. Delete items from this file as they land.

| Order | Work                                                                  | Why now                                        |
| ----- | --------------------------------------------------------------------- | ---------------------------------------------- |
| 1     | [Git follow-ups](#1-git-follow-ups)                                   | Deployment setting and open edges of the slice |
| 2     | [Long runs and sandbox lifecycle](#2-long-runs-and-sandbox-lifecycle) | Paid proof of the long-run path                |
| 3     | [Rest of the MVP](#3-rest-of-the-mvp)                                 | The first real coding task                     |
| Any   | [Known limits](#4-known-limits)                                       | Each has its own trigger, listed below         |
| Any   | [Architecture cleanup](#5-architecture-cleanup)                       | Each has its own trigger, listed below         |

## 1. Git follow-ups

- [ ] Set `PUBLIC_URL` where the Worker is deployed. Without it, `git_clone` fails and the proxy has no address to give sandboxes.
- [ ] Try the PAT routes, proxy, push policy and approvals once against real GitHub with a throwaway repo and a fine-grained PAT. Everything so far ran against a fake backed by real git. Needs explicit approval.
- [ ] Confirm GitHub accepts `Authorization: Basic x-access-token:<PAT>` for fine-grained PATs on smart-HTTP (documented for installation tokens; not yet seen for PATs).
- [ ] The clone started at session creation is detached and unreconciled. If that matters, drive it from a first message or a durable job instead.
- [ ] A crash test for an approval left in `executing`. Reconciliation is covered through `unknown` (same code path), but the persisted-then-crash window is not injected.
- [ ] Replace the post-hoc force-push revert with pack parsing, if the brief window where the session branch shows the forced commit ever matters.

## 2. Long runs and sandbox lifecycle

**Rule:** a thread has no token, turn or wall-clock cap. Concurrency across threads is the only enforced limit.

**Built:** keep-alive, resume, interruption, the cap, the idle-delete alarm and sandbox replacement (see [`AGENTS.md`](AGENTS.md#lifecycle)). **Still open:** when fork is built, pass `ttlSeconds` to it (a fork otherwise gets 1 h), and the paid proofs below.

### Prove it

Paid tests need explicit approval.

- [ ] Run a command for over an hour on live Boat, about $0.04 per sandbox hour.
- [ ] Restart the Thread during that command. This is the main unknown: Cloudflare alarms have a 15-minute wall-time limit, and nothing has been tested past a few minutes.
- [ ] Check whether a very long single model response hits a platform limit.
- [ ] Stop and resume a sandbox mid-run, and confirm files survive and the session recovers.

## 3. Rest of the MVP

- [ ] Run a real end-to-end task: clone, edit, test, push, plus lost receipts, restart and cancellation. **Paid, needs explicit approval.**

## 4. Known limits

| Limit                                           | Effect                                                                                            | Resolve                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `NativeContent.parse` throws on unknown content | Snapshots and history containing that entry may fail, breaking the session's view. Not yet tested | Before a Pi upgrade or V1 image attachments                 |
| A killed supervisor can leave its child running | The command ends as `lost` with a warning, but the agent could rerun it beside the old one        | Process groups help on a clean stop. Leave until it happens |
| SSE disconnects may log an error                | Log noise that could hide real failures. Not yet confirmed                                        | Check during the first live run                             |

## 5. Architecture cleanup

| Cleanup                         | Problem today                                                    | When                                                       |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Typed store modules             | Done: `sessions/{thread,catalog}-store.ts`, `command-records.ts` | Done                                                       |
| Schemas beside adapters         | Done: `workspaces/{boat,docker}-schemas.ts`                      | Done                                                       |
| HTTP out of domain code         | `messages.ts` and others return `Response` objects directly      | When a non-route caller appears, such as MCP or delegation |
| Direct Worker-to-Thread routing | All session traffic goes through the single `SessionCatalog`     | When parallel sessions show contention                     |
| Shared test harness             | Tests repeat their setup                                         | When it slows new tests                                    |
