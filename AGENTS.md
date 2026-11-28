# AGENTS.md

Rules for working in this repo. Read the docs below before starting; they hold everything else.

| Doc                                                  | Holds                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)       | Design, security boundaries, decisions and implementation status. The authority on them         |
| [`docs/mvp.md`](docs/mvp.md)                         | Delivery scope, priorities and the feature checklist                                            |
| [`docs/effect.md`](docs/effect.md)                   | Where Effect is used, and how                                                                   |
| [`docs/infra-decisions.md`](docs/infra-decisions.md) | Decisions and test results on credentials, secrets, port URLs, providers and the Git proxy      |
| [`docs/network-secrets.md`](docs/network-secrets.md) | A plain-language walkthrough of the network-secret swap. Explains the design; doesn't decide it |

**Keep them current, in the same change.** Record each decision in [Decisions](docs/architecture.md#decisions) with a date, and update status and scope rows when implementation lands. If a section goes stale, fix it rather than adding a contradicting note. Don't create other design docs. Package READMEs (`protocol/README.md`, `server/README.md`) describe their code's contracts only.

## Working rules

- **Build order:** always write the protocol (`protocol/`) and its tests before application code. Then build the backend (`server/`), then its API routes.
- **One file per concern, at most 500 lines.** Fold closely related small files together instead of spreading one concern across many; split a source file by concern before it passes 500 lines. Test files are exempt from the limit. `eslint/max-lines` enforces it.
- **Layers:** server folders import in one direction: `workspaces`, `sandbox`, `git`, `tools`, `sessions`, each only from the ones before it. Root modules (`env.ts`, `errors.ts`, `storage.ts`, `thread-store.ts`) are open to all of them. Lint enforces it.
- **Grow in layers.** Each step ships working and tested before the next starts.
- **GitHub PR tools** from the original `cloud-swe` belong to the MVP Git slice.
- **Committing:** when assigned a feature request or spec that changes app functionality, commit atomically without asking, and list the commits at the end. Leave anything else, such as a standalone documentation change, uncommitted for review.
- **Pi tool behavior:** reuse upstream tool constructors/types and durable codemode. Support direct single calls, sequential rounds and parallel calls with Pi's parallel default; codemode is now MVP, not V1. Do not create a second scheduler or duplicate parameter schemas.
- **File headers:** every source, test and script file over 20 lines starts with a `Path:`, `Used by:` and `Purpose:` comment, followed by a blank line (without it, oxfmt moves the header when it sorts imports). `Used by:` lists the files that import this one within its own tree, so tests are not listed on the source they exercise; `{a,b}.ts` groups a folder. `cloud-swe/file-header` checks all of it against the real imports. Root `tools/` is exempt.
- **API errors:** add them only to `API_ERRORS` in `server/src/errors.ts`. Messages are plain and actionable, with no internals or upstream text.
- **E2B is the only provider:** features and live tests target E2B. Docker is a test double that mimics an E2B pause; Docker tests don't prove E2B, so say when something is verified only in Docker.
- **Stay within the release scope.** Follow the immediate priorities in [`docs/mvp.md`](docs/mvp.md). Backlog additions are not instructions to implement V1 ahead of MVP. Get explicit user direction before promoting V1 work into MVP; update both documents when priorities change.

## Boundaries

Never cross these. The reasoning is in [`docs/architecture.md`](docs/architecture.md).

- **No platform credentials in a sandbox:** no Git or model credential enters its files, env vars, commands or template. Normal secrets from the session's chosen environment may. Sessions run Pi only, so no Claude credential enters a sandbox. See the credential tiers in [`docs/infra-decisions.md`](docs/infra-decisions.md).
- **Network-secret values never enter a sandbox:** the sandbox holds only placeholders, and the Worker's `/net` route swaps the value in. The daemon config's network token is a capability scoped to one sandbox, not a credential.
- **No blind re-execution:** an unknown command outcome is not success. A replayed shell tool may reattach to its saved job by ID, which is why the `bash` wrapper is `replay: 'safe'`; it must never run the command again. Never rerun a command because a request failed.
- **One authority per engine session:** never let two runtimes drive the same conversation.
- **Keys stay put:** no API returns a stored key, and no platform credential or network secret reaches a log, result or Pi record. Normal secrets are visible to the agent, so they may.
- **The attachments bucket is public:** an object's random key is its only protection, so no API, log, result or Pi record carries a key or bucket address, and nothing but attachment files goes in the bucket.
- **Real sandboxes cost money:** `pnpm test --e2b` is billed, at cents a run. Docker is enough for most changes, including small ones to what runs in a sandbox. Run live tests only when a change could pass in Docker and still break on a cloud sandbox, such as the Git proxy, the model path, other network hops or provider behavior, and list what's left afterwards. Never create snapshots automatically.
- **Never run `docker compose` directly for tests:** Compose reads the root `.env`, where `WORKSPACE_BACKEND` and the real provider keys send live tests to a real, billed account. Use `pnpm test`, which forces Docker. For a single test file, set `WORKSPACE_BACKEND=docker E2B_API_KEY=` in the same command and confirm with `docker compose config` first. If tests reached E2B, list the account's sandboxes and report what's left.

## Checks

- `pnpm test`: all contract tests, typechecks and integration tests, run inside Docker. `pnpm test --e2b` also runs the tests written for E2B on real sandboxes (billed; the suite deletes them), and needs `E2B_API_KEY` and the `cloud-swe` template (`pnpm --filter server e2b:template`). Every other test stays on Docker, and `server/test/sandbox-live.ts` holds the adapter checks E2B must pass.
- `pnpm test --github` swaps the fake GitHub for the real one: `server/test/github-live.test.ts` clones, pushes, tries forbidden pushes and opens a draft PR through the Worker on the public scratch repository `sudoanmol/cloud-swe-e2e`, with the Docker sandbox and a scripted model. It needs `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY` in the environment, so run `node --env-file=.env scripts/test.mjs --github`. It is free, writes only to that repository, and closes its PR and deletes its branches even when it fails. Flags compose: each swaps one double, refuses to start without its variables, and passes them to the tests only when it is on. `--e2b --github` runs the same test on a real E2B sandbox (billed): the test opens a cloudflared quick tunnel from the test container so the sandbox can reach the Worker's Git proxy, and kills it at the end. The tunnel makes the test Worker public while it holds real keys, which is why the rig's bearer token is random for each run. Quick tunnels get a new hostname each run, allow 200 requests in flight, carry no server-sent events and have no uptime guarantee.
- `pnpm test --anthropic` swaps the scripted model for the real one in `server/test/anthropic-live.test.ts` only: with the Docker sandbox, a turn that must run a shell command and quote its output (checking the tool outcome, that the event stream showed the partial message and rebuilds the snapshot, and that usage and cost grew), and a run with a wrong saved key that must fail as `auth` with none of Anthropic's error text. Every other test keeps the scripted model. It calls `claude-sonnet-5-5` (the tests' `MODEL_ID`) and needs `ANTHROPIC_API_KEY` in the environment, so run `node --env-file=.env scripts/test.mjs --anthropic`. It is billed, at cents a run. It composes with `--e2b` and `--github`, though its tests still use the Docker sandbox.
- `pnpm lint`: type-aware oxlint with the vendored anti-slop plugins (`tools/oxlint/anti-slop/`, see its `UPSTREAM.md`) and this repo's own rules (`tools/oxlint/cloud-swe/`).
- `pnpm fmt` / `pnpm fmt:check`: oxfmt.
- `pnpm knip`: unused files, exports and dependencies.
- `pnpm leaks`: gitleaks over the whole Git history; needs `brew install gitleaks`. Reviewed false positives go in `.gitleaksignore`.
- `pnpm typecheck`: `protocol`, `server` and this repo's lint rules.
- Pre-commit runs gitleaks on staged changes, then lint-staged (`oxfmt`, then `oxlint --fix`, on staged files), then `pnpm lint` on everything, because a change to one file can make another file's `Used by:` stale.
- CI (`.github/workflows/ci.yml`) runs lint, format, knip, gitleaks and `pnpm test` on pull requests, `main` and `rewrite`. A push to either branch deploys both Workers once they pass, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. Pull requests only run the checks; nothing deploys them. Worker secrets stay in Cloudflare; a deploy doesn't change them.
- Local dev: `pnpm dev` loads the root `.env` (copy `.env.example`). Tests inject their own bindings and ignore `.env`.

## Lessons

- `cloud-swe/file-header` has no fixer: after moving a file or changing an import, rewrite the `Used by:` line by hand; `pnpm lint` prints the expected text.
- A subagent's isolated worktree starts at `main`, not at your branch: have it `git reset --hard <your tip>` before it reads or edits anything.
- Run one `pnpm test` at a time. Parallel runs from several worktrees make timing-sensitive tests fail and can fill the disk: each checkout builds its own `cloud-swe-tests-<hash>-*` images, so delete those when you remove a worktree.
- A change to a stored record's shape is an upgrade step on its kind in `protocol/src/storage.ts`, never a Durable Object rename or wipe. `server/test/stored-records.test.ts` holds rows exactly as production stored them; add new fixtures there, never edit the old ones.
- Never look a cloudflared quick tunnel's hostname up before Cloudflare publishes it: the "not found" answer stays cached for over a minute. Wait for the record over DNS-over-HTTPS first, as `routed` in `server/test/github-live.test.ts` does.
- Never list `.env` names with `cut -d= -f1`: `GITHUB_APP_PRIVATE_KEY` spans many lines, and `cut` prints the lines without an `=` in full.
- Effect's default logger prints a formatted string, which Workers Logs can't split into fields: log a plain object with `console.error`, as `logFault` does.
- Each Catalog stamps its sandboxes with a random ID (`cloudSweCatalog`) kept in its storage, and its sweep deletes only those. Wiping a Catalog's storage (such as a reset local `.wrangler` state) gives it a new ID, so its old sandboxes are never swept: delete them by hand.
- `NetworkAccess` and `SandboxSync` are stored records defined in `server/src/sandbox/egress.ts`, not in `protocol/src/storage.ts`. `NetworkAccess` treats an unreadable row as no access (a regenerable capability), so its shape can change without an upgrade step.
- Workerd's console output reaches the test process's stdout, so `mock.method(process.stdout, 'write')` around a flow can assert that nothing secret was logged. Include a positive control line, as `server/test/auth.test.ts` does.
- A Thread RPC method that returns a `Snapshot` or `HistoryResponse` (or a `Result` of one) fails to typecheck at the stub with TS2589: return a `Response` from the Thread, built with `respond()`. The same error appears when a stub call is returned straight from a Hono handler expression: assign the stub to a variable or use an `if` first.
- Session routes run in the Worker and reach the Thread by RPC. A route that refuses a request for its body or query returns `thread.refuse(code)`, so an unknown session still answers 404 first and Pi is never started for it.
- Pi's `ConversationView.entries` puts a head marker (compaction or reset) first, with a newer ID than the entries after it: the newest entry is the highest ID, not the last element.
- Inside Workers, call an RPC stub's method through a Proxy with `Reflect.apply`; the stub sends `method.apply(...)` as a remote call named `apply`.
- Pi writes a streaming partial to `pi.live` only 100 ms after the message's first content (`partialIntervalMs`), so a model answer that finishes sooner never appears as a `live.message`. A test that needs one must make the answer stream longer than that.
- A test that expects a refusal by `Content-Length` (413 over a body limit) must send the headers and no body, as `declared` in `server/test/attachments.test.ts` does: the Worker answers without reading, and a client still writing megabytes into the closed connection fails with `EPIPE` on some runs.
- A Pi fork copies the agent configuration (`pi.agent`) but starts usage, the inbox and live state empty; `createConversation` copies nothing. Entry IDs are session-wide and only grow, so an entry ID orders events across conversations.
- Stored approvals, questions and secret requests carry `afterEntry`: spread the stored row (`{ ...stored, … }`) when rewriting one, and give a hand-built test row its `afterEntry`.
