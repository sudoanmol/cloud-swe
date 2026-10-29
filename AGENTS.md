# AGENTS.md

[PLAN.md](PLAN.md) is the source of truth for what we build first. Read it before starting work.

## Build order

1. Always generate the protocol (`protocol/`) and its tests before writing application code.
2. Then move on to the backend (`server/`), followed by its API routes.

## Working documents

For core pieces of the project, such as architecture, always keep a working document in `docs/`. Update it as things progress, in the same change that moves the code.

## Code organization

Never write god files. Split files by concern and organize them into folders.

## Checks

- `pnpm lint` runs oxlint with the vendored anti-slop plugin (`tools/oxlint/anti-slop/`, see its `UPSTREAM.md`)
- `pnpm fmt` / `pnpm fmt:check` runs oxfmt
- `pnpm knip` finds unused files, exports, and dependencies
- `pnpm typecheck`
- Pre-commit runs lint-staged: `oxlint --fix` then `oxfmt` on staged files
