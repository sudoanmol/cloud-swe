# AGENTS.md

Rules for working in this repo. Read the docs below before starting; they hold everything else.

| Doc                                            | Holds                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md) | Design, security boundaries, decisions and implementation status. The authority on them |
| [`docs/mvp.md`](docs/mvp.md)                   | Delivery scope, priorities and the feature checklist                                    |
| [`docs/effect.md`](docs/effect.md)             | Where Effect is used, and how                                                           |

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
- **Stay within the release scope.** Follow the immediate priorities in [`docs/mvp.md`](docs/mvp.md). Backlog additions are not instructions to implement V1 ahead of MVP. Get explicit user direction before promoting V1 work into MVP; update both documents when priorities change.

## Boundaries

Never cross these. The reasoning is in [`docs/architecture.md`](docs/architecture.md).

- **No credentials in a sandbox:** no Git or model credential enters its files, env vars, commands or Boat environment. The Claude runner token is the one documented exception.
- **No blind re-execution:** an unknown command outcome is not success. Never mark a shell tool `replay: 'safe'`, and never rerun a command because a request failed.
- **One authority per engine session:** never let two runtimes drive the same conversation.
- **Keys stay put:** no API returns a stored key, and no key reaches a log, result or Pi record.
- **Boat costs money:** run `pnpm test --boat` only when asked. Never create snapshots automatically.

## Checks

- `pnpm test`: all contract tests, typechecks and integration tests, run inside Docker. `pnpm test --boat` provisions real Boat sandboxes (billed; the suite deletes them) and needs `BOAT_API_KEY`.
- `pnpm lint`: type-aware oxlint with the vendored anti-slop plugins (`tools/oxlint/anti-slop/`, see its `UPSTREAM.md`) and this repo's own rules (`tools/oxlint/cloud-swe/`).
- `pnpm fmt` / `pnpm fmt:check`: oxfmt.
- `pnpm knip`: unused files, exports and dependencies.
- `pnpm leaks`: gitleaks over the whole Git history; needs `brew install gitleaks`. Reviewed false positives go in `.gitleaksignore`.
- `pnpm typecheck`: `protocol`, `server` and this repo's lint rules.
- Pre-commit runs gitleaks on staged changes, then lint-staged (`oxfmt`, then `oxlint --fix`, on staged files), then `pnpm lint` on everything, because a change to one file can make another file's `Used by:` stale.
- CI (`.github/workflows/ci.yml`) runs lint, format, knip, gitleaks and `pnpm test` on pull requests, `main` and `rewrite`. A push to either branch deploys both Workers once they pass, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. Worker secrets stay in Cloudflare; a deploy doesn't change them.
- Local dev: `pnpm dev` loads the root `.env` (copy `.env.example`). Tests inject their own bindings and ignore `.env`.
