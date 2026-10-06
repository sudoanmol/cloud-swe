# Agent environments and secrets: research and v1 plan

Researched and revised October 6, 2026. Competitor claims come from vendor documentation retrieved on that date, not from audits of proprietary implementations. Product availability can change. Nothing in this document is implemented yet.

## Decision

Ship **v1: named environments with readable values, transcript redaction, and a Git secret scan.** This matches the documented secret handling of Cursor Cloud Agents and Devin. Keep network secrets (v2) and automatic egress review (v3) as separate, later projects.

The v1 promise, worded so that it can be enforced:

> Environment values are encrypted at rest and kept out of transcripts, model calls, logs, durable records, and commits. Code running in the sandbox can read them. Use development or restricted keys.

Do not promise that the agent cannot read a value. Ordinary environment variables cannot provide that guarantee, because the agent runs arbitrary commands as root inside the sandbox.

## What competitors document

| Capability                                         | Cursor Cloud Agents                                 | Devin                                                        | Cloud SWE v1                                   |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| Encrypted storage                                  | Yes (KMS)                                           | Yes                                                          | Yes (AES-256-GCM, server-side key)             |
| Values readable by sandbox code                    | Yes, loaded as env vars and visible in the terminal | Yes, bound as env vars to commands                           | Yes                                            |
| Redacted from tool output and transcript           | Yes, documented for Runtime Secrets                 | Only "redacted in logs" (API `sensitive` field), unspecified | Yes                                            |
| Redacted or blocked in commits                     | Yes (redacted)                                      | Not documented                                               | Yes (proposal blocked)                         |
| Kept out of VM snapshots                           | Not documented                                      | Yes, documented                                              | Yes, never written to disk by Cloud SWE        |
| Separate visible (non-secret) variables            | Yes ("Environment Variable" type)                   | No                                                           | Yes (per-entry `secret` flag)                  |
| Agent requests a secret in chat                    | Not documented                                      | Yes, session-scoped                                          | Optional milestone M6                          |
| Build-only secrets                                 | Yes (Docker build secret mounts)                    | Enterprise only                                              | Not applicable: no user-defined build step yet |
| Egress domain allowlist                            | Yes (allowlist modes per user, environment, team)   | Not documented                                               | v2                                             |
| Short-lived identity tokens (OIDC)                 | Yes                                                 | No                                                           | Out of scope                                   |
| Real key never enters the sandbox (network secret) | No                                                  | No                                                           | v2                                             |

On secret handling itself, v1 matches the documented behavior of both products. Cursor documents two adjacent controls that v1 does not include: egress allowlists and OIDC tokens. The allowlist belongs in v2. Devin's site cookies and TOTP secrets are browser login features, not part of this plan.

### Cursor

Source: [Secrets & Network](https://cursor.com/docs/cloud-agent/security-network) and [Security overview](https://cursor.com/docs/cloud-agent/security).

> Secrets set with type `Runtime Secret` are still loaded as environment variables, but their contents are redacted from the agent's tool call results, chat transcript, commits, and commit messages, and replaced with the placeholder string `[REDACTED]`.

> Because Runtime Secrets still function internally as environment variables, while they are not shown to the agent, they are still visible to users interacting with the agent's environment via the Terminal.

> Mark secrets as Runtime Secrets so their values are stripped from the transcript, tool output, and commits and never reach the model.

Cursor's "not shown to the agent" and "never reach the model" describe the transcript. Nothing in the documentation prevents agent-run code from encoding a value before printing it. Do not copy that wording.

### Devin

Source: [Secrets](https://docs.devin.ai/product-guides/secrets), [Blueprint reference](https://docs.devin.ai/onboard-devin/environment/blueprint-reference), and [Create Secret API](https://docs.devin.ai/api-reference/v1/secrets/create-secret).

> Devin provides each secret to the specific commands and tools that need it. … Secrets are not exported into every shell.

> They are scrubbed from the snapshot image itself, so credentials are never baked into saved machine images.

The API's `sensitive` field is described as "Whether the secret should be treated as sensitive and redacted in logs." The documentation does not say whether this covers the model's context. The "sanitized transcript (secrets redacted)" wording belongs to Devin Local and CLI transcript sharing, not to cloud sessions.

Devin binds secrets per command, but the agent chooses those commands, so the binding limits exposure rather than creating a boundary against the agent. v1 delivers values to every command, as Cursor does.

### Products that keep keys outside the sandbox (v2 reference)

- **Claude Code cloud** ([cloud environments](https://code.claude.com/docs/en/cloud-environments)): "Anthropic's agent proxy adds the key to requests for the hosts you list, after each request leaves the session's VM." Setup scripts do not receive these credentials.
- **Codex Cloud** ([environments](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets)): "Programs receive a placeholder; the proxy substitutes the real value for allowed destinations." HTTPS on port 443 only.

Both cover only API keys sent in HTTPS headers. Neither covers database passwords, local signing keys, or AWS request signing.

## Threat model

Separate two harms:

1. **Theft.** The raw value leaves the sandbox, and an attacker keeps using it after the session ends.
2. **Misuse.** The agent uses the credential's powers during the session.

Hiding the value from the guest (v2) addresses theft only. Restricted, scoped keys address both theft and misuse, so the product should recommend them in all versions.

### Local agent versus cloud sandbox

A local agent can also read `.env`, and its values reach the model provider when it does. A local agent can also reach `~/.ssh`, `~/.aws`, and browser cookies, which the sandbox does not contain.

The cloud raises risk in three ways:

- **Unattended execution.** Users disconnect while runs continue with internet access and a hosted browser. A prompt injection from a web page, issue, README, or install script has time to act without a human watching.
- **Custody.** Values live in Cloud SWE's database, events, checkpoints, logs, and workspace snapshots, in a multi-tenant system. An authorization bug can leak another user's secrets. This risk belongs to Cloud SWE, which is why v1 focuses on custody.
- **Exposure surface.** Repository code runs as root with open egress in long-lived workspaces.

### Why not review or block commands

A command classifier, whether pattern rules or a decision model, is a probabilistic filter rather than a boundary:

- Values leak through ordinary commands: a crashing dev server prints its config, a failing test prints `process.env`, or the agent adds `console.log(config)` while debugging. Each command looks harmless when reviewed alone.
- Encoding (`base64`, Python, splitting a value) defeats both pattern rules and redaction.
- Redaction already neutralizes the main harm of `cat .env`, because the model sees `[REDACTED:NAME]`.

[Codex auto-review](https://developers.openai.com/codex/agent-approvals-security) does not review every command. It reviews **sandbox escalations**, such as blocked network access or writes outside the workspace, on top of a real sandbox boundary. In Cloud SWE the whole Modal VM is the sandbox, so there is no inner boundary to escalate across. A reviewer becomes useful once an egress choke point exists (v3).

## v1 design

### Current code facts that shape the design

- `apps/runner/src/pi.ts:918` renders `guestEnvironment` as `export NAME='value' &&` and prepends it to every command (`pi.ts:1185`).
- The execution coordinator persists that full command string in `command_operation.metadata.request.command` (`apps/runner/src/execution-coordinator.ts:691`).
- `apps/runner/src/guest-command.ts:271` writes the command to `/tmp/cloud-swe-commands/<id>/command.sh` in the guest, which ends up in exit snapshots.
- `settle()` in the coordinator persists `stdout`/`stderr` to `command_operation.result` (`execution-coordinator.ts:483`).
- Live output reaches the database as `tool.output` events in chunks (`pi.ts:1166`).
- The Modal SDK's `sandbox.exec` accepts `env?: Record<string, string>`.

As a result, secret values must not travel in the command string, and guest output must be redacted inside the coordinator before `settle()` and before progress events.

### Data model

```text
environment            (id, user_id, name, created_at)                       unique (user_id, name)
environment_revision   (id, environment_id, encrypted, entries jsonb, created_at)
                       entries = [{ name, secret }]  -- names and flags only; values live in `encrypted`
thread.environment_revision_id  -> environment_revision, on delete set null
run.environment_revision_id     -> environment_revision, on delete set null, copied at admission
```

- Revisions are append-only. Editing an environment creates a new revision.
- A thread points to one revision, and follow-up runs keep it until the user explicitly changes it.
- A run copies the thread's revision when it is admitted. Temporal activity retries then read the same values, and a change during a run applies only to the next run.
- Deleting an environment cascades to its revisions, which purges all ciphertext. Threads that referenced it fall back to no environment, and the UI shows that.
- "Environment" already names the runtime facts in `PiEnvironment`. Choose distinct code names, for example `envSet`, so the two concepts do not mix.

### Encryption

Follow `packages/db/src/model-credentials.ts`: AES-256-GCM, a fresh nonce, a version byte, and AAD binding `["environment", userId, environmentId, revisionId]` so rows cannot be swapped. Encrypt the whole name-to-value map as one blob per revision.

Use a separate `ENVIRONMENT_ENCRYPTION_KEY`, validated in `packages/env`, shared by the API server (Git scan) and the runner (delivery). Keep it out of PostgreSQL, images, and the guest.

### Validation

- Parse `.env` input with `dotenv.parse`, which performs no command evaluation and no variable expansion. Reject duplicate names.
- Names must match `^[A-Za-z_][A-Za-z0-9_]*$`. Reject reserved names: `PATH`, `HOME`, `SHELL`, `GIT_CONFIG_GLOBAL`, `PREVIEW_URL_TEMPLATE`, and anything starting with `__VITE_` or `CLOUD_SWE_`.
- Secret values must be at least 8 characters, because shorter values cannot be redacted without mangling ordinary output. Shorter values must be stored as plain (non-secret) entries.
- Cap total size, for example 64 KiB per revision, which stays well under Linux environment limits.
- Apply Zod validation at the API boundary and when decrypting.

### Delivery

- Add `env?: Record<string, string>` to `CommandRequest`. Never serialize it into command metadata, the guest journal, or events, following the same rule as `progress`.
- Pass it through the coordinator to the provider: Modal `sandbox.exec(cmd, { env })`, plus the Docker exec equivalent. The journal wrapper and `command.sh` inherit it.
- Remove the `guestExports` string path entirely. Move `PREVIEW_URL_TEMPLATE` and `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` onto the same `env` field, leaving one delivery path.
- Reconciliation never redispatches, so it never needs the values.
- Values come from the database for every run, so pause and resume need no special handling. Processes started earlier keep the values they started with until restarted.

### Redaction

- Build one redactor per run from the run's secret entries. It replaces each secret value with `[REDACTED:NAME]`.
- Apply it in the coordinator to guest output **before** `settle()` persists it and before progress chunks become `tool.output` events. Every workspace command, including the read and edit tools, passes through the coordinator, so this one point covers model-visible tool results, events, checkpoints, and `command_operation.result`.
- For live chunks, hold back the last `maxSecretLength - 1` bytes of each stream until the next chunk or the end of the stream, so a value split across chunks is still redacted. Progress offsets remain guest byte offsets. Confirm the frontend does not derive text length from them.
- Also redact run errors and diagnostics that include guest output.
- Exact-match only. Encoded or transformed values are a documented limit.

### Git secret scan

During proposal creation in `packages/api/src/routers/git-broker.ts`, the server has already imported the bundle into a bare repository. Scan the following for exact secret values from the thread's revision:

- Added content between base and commit
- Commit messages
- PR titles, bodies, and comments

On a match, refuse the proposal with a tool error naming the variable, never the value. Blocking is simpler and more honest than rewriting the user's commits, which is what Cursor's redaction does.

### Agent awareness

Add the environment's names and secret flags (never values) to the environment block in `pi-system-prompt.ts`, with a policy along these lines: "These variables are set for every command. Secret values appear as `[REDACTED:NAME]` in output. Do not print, write, or commit them." Without this, the agent sees placeholders and gets confused.

### API

Add a route module `packages/api/src/routers/environments.ts`, and update the route list in `AGENTS.md`.

| Route                              | Behavior                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/environments`            | Owned environments with the latest revision's names and flags. Never values.                                                                                                |
| `POST /api/environments`           | Create from a name and entries, or from `.env` text.                                                                                                                        |
| `PUT /api/environments/:id`        | New revision. Each entry is `{ name, secret, value? }`; an omitted `value` keeps the previous revision's value server-side, so the browser never needs to read values back. |
| `DELETE /api/environments/:id`     | Delete the environment and its revisions.                                                                                                                                   |
| `PUT /api/threads/:id/environment` | `{ environmentId \| null }`. Attaches, switches, updates to the latest revision, or detaches. Takes effect at the next run.                                                 |

Thread creation accepts an optional `environmentId` and resolves the latest revision in the same transaction. Follow-up submissions do not change the revision. Every route checks ownership, and cross-user references fail. Mutations follow the existing CSRF and `Origin` rules. Never log request bodies.

### UI

- **Settings → Environments:** list, create, paste or upload `.env`, toggle the secret flag per row, edit names and flags, replace values. Values are write-only, so the UI shows "set" rather than the value.
- **Composer:** an environment picker. Remember only the selected environment ID in browser storage.
- **Thread header:** environment name and revision date. Show "Update to latest" when a newer revision exists, and "No environment" after deletion, with the picker.
- **Copy:** "Readable by code in the sandbox. Hidden from the transcript, model, and commits. Use development or restricted keys."

### Known limits (state these in user docs)

- Code in the sandbox can read every value, including through encodings that redaction cannot match.
- Redaction is exact-match. A value split, encoded, or transformed by a program is not caught.
- Values written to files by the agent or the app persist in the workspace and its exit snapshot for up to 30 days. The guest command journal under `/tmp/cloud-swe-commands` keeps raw output too. Check whether settled journal entries can be deleted after `settle()`; if not, document it.
- The diff and review panel shows file contents to the user unredacted. This is user-only and not model-visible.
- Values typed into chat messages by the user are not redacted.
- A key in v1 can be misused within its own permissions during a run.

## v1 roadmap

Each milestone builds on a working product and ends with observable tests.

### M1: delivery without persistence

- Add `CommandRequest.env`, pass it through the coordinator, Modal, and Docker, and delete `guestExports`.
- Move the preview variables onto `env`.
- **Accept:**
  - `printenv NAME` returns the value through the journal wrapper on Docker and on the Modal scripted test.
  - No value appears in `command_operation.metadata` or `command.sh`.
  - Preview variables still work.

### M2: storage, revisions, API

- Migration for `environment`, `environment_revision`, and the thread and run columns.
- Encryption module with `ENVIRONMENT_ENCRYPTION_KEY`.
- `.env` import and validation.
- Routes, thread creation with `environmentId`, the thread environment route, and copying the revision at run admission.
- **Accept:**
  - Round-trip encryption works, and swapped rows fail to decrypt.
  - A cross-user environment reference is rejected.
  - Editing an environment leaves an existing thread on its old revision.
  - "Update to latest" applies at the next run, not the active one.
  - Deleting an environment purges ciphertext, and the thread falls back to no environment.
  - API responses never contain values.

### M3: redaction

- Coordinator redactor with chunk-boundary holdback, run error redaction, and agent awareness in the system prompt.
- **Accept:**
  - `cat .env` and `printenv` produce `[REDACTED:NAME]` in tool results, `tool.output` events, checkpoints, and `command_operation.result`.
  - A value split across two progress chunks is redacted.
  - Plain (non-secret) entries remain visible.
  - The app can still use the value, for example `test "$KEY" = expected && echo ok`.

### M4: Git secret scan

- Scan in proposal creation.
- **Accept:**
  - A commit containing a secret value is refused with an error naming the variable.
  - A PR body containing one is refused.
  - A clean push is unaffected.

### M5: frontend

- Settings page, composer picker, thread header, and copy.
- **Accept:**
  - Import a `.env` file, start a thread, and have the agent run an app that uses the key.
  - The transcript shows only redacted values.
  - Browser storage holds only environment IDs.

### M6 (optional, Devin parity): agent-requested secrets

- A typed `request_environment_variables` tool that reuses the durable question-wait lifecycle. It records names, purpose, and the target environment.
- Values go to a separate authenticated submission endpoint, never through question answers. Saving creates a new revision, attaches it to the thread, and resumes the run atomically.
- The user enters values in a Cloud SWE dialog, never inside the preview or hosted browser.

**Validation for every milestone:** `bun run check-types`, `bunx oxlint`, `bunx oxfmt --check`, focused tests, and, because M1 through M4 touch persistence and recovery, `bun run test:db` and `bun run test:backend`.

## Later: v2 network secrets and egress control

This is a separate project. Start it only after v1 has users who need it.

- An external TLS-terminating proxy outside the Modal VM. The guest holds a placeholder, and the proxy inserts the real key for approved HTTPS hosts in supported header locations.
- Guest authority is short-lived and bound to user, thread, workspace generation, and entry. Revoke it on pause, deletion, or rotation.
- The guest trusts the proxy's CA. The CA's private key stays outside the guest. Test Node, Bun, Python, curl, and Docker clients.
- The same choke point enables a Cursor-style egress allowlist. Enforce it at the provider network level, not with guest firewall rules that root inside the guest can change.
- **Out of scope even for v2:** local signing keys, database passwords, and non-header authentication.
- **First step:** prove the proxy boundary with one real SDK and a development key. Cover placeholder-only reads, wrong-host rejection, cross-thread rejection, response reflection, revocation, pause and resume, and proxy bypass.

## Later: v3 automatic review at the egress choke point

This requires v2's choke point. Review new egress destinations, and possibly browser form submissions, against the user's task. Approve automatically above a confidence threshold and ask the user otherwise, following [Codex auto-review](https://alignment.openai.com/auto-review/).

Candidate decision models return typed answers with calibrated probabilities:

- [TypeSafe Jev](https://typesafe.ai/) (early access since September 15, 2026)
- [OpenAI Decisions API](https://www.neowin.net/news/openai-unveils-500-chatgpt-pro-plan-decisions-api-and-major-codex-upgrades-at-devday-2026/) (limited preview)
- [Cloudflare Clef](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/) (open weights on Workers AI, released October 1, 2026)

Prefer open weights to avoid depending on a preview API. The reviewer reads attacker-influenced content and can itself be prompt-injected, so it adds to enforced egress controls and never replaces them.

## Sources

- [Cursor: Secrets & Network](https://cursor.com/docs/cloud-agent/security-network)
- [Cursor: Security overview](https://cursor.com/docs/cloud-agent/security)
- [Devin: Secrets](https://docs.devin.ai/product-guides/secrets)
- [Devin: Blueprint reference](https://docs.devin.ai/onboard-devin/environment/blueprint-reference)
- [Devin: Create Secret API](https://docs.devin.ai/api-reference/v1/secrets/create-secret)
- [Claude Code: cloud environments](https://code.claude.com/docs/en/cloud-environments)
- [Codex Cloud: environments](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets)
- [Codex: agent approvals and security](https://developers.openai.com/codex/agent-approvals-security)
- [OpenAI: auto-review of agent actions](https://alignment.openai.com/auto-review/)
