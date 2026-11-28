---
name: ship-pr
description: Take one task from a prompt to a pull request with passing CI and a description the owner can act on. Use when asked to ship, finish, or complete a task end to end and open a PR, usually from a fresh worktree session.
argument-hint: "What should the agent build or fix?"
---

# Ship a PR

Finish one task in the current worktree, open a pull request against `rewrite` whose description follows `.github/pull_request_template.md`, and watch CI until it passes.

At any step, if you need a question answered or a requirement clarified, ask the user and wait for the answer. Do not guess at behavior, scope, or product decisions.

## 1. Confirm the task

Treat the arguments as the task. If they are missing or too vague to act on, ask what to build and stop until the user answers. Do not invent work.

Check the task against the immediate priorities in `docs/mvp.md`. If it is V1 or backlog work that isn't yet prioritized, ask before starting.

## 2. Prepare the worktree

- Run `git status` and preserve unrelated changes.
- `.env` is gitignored, so new worktrees lack it. If it is missing, copy it from the main checkout and never commit it:

  ```sh
  cp "$(git worktree list --porcelain | awk 'NR==1 {print $2}')/.env" .env
  ```

- Run `pnpm install`.

## 3. Implement

Read `AGENTS.md` and the docs it points to (`docs/architecture.md`, `docs/mvp.md`, `docs/effect.md`, `docs/infra-decisions.md`) for the area you touch, then make the change. Keep to the task.

Keep notes for the PR description as you go, because they are hard to rebuild at the end: each decision and the options you rejected, anything out of scope you noticed (for **Still to do**), limits you chose to accept, and anything the owner must do before merging. For a visible change, capture the before state now, ahead of your first edit.

Follow the build order: protocol (`protocol/`) and its tests first, then the backend (`server/`), then its API routes. Respect the repo's hard rules: one concern per file and at most 500 lines, the one-way server folder layers, `Path:`/`Used by:`/`Purpose:` headers, API errors only in `API_ERRORS`, no platform credential in a sandbox, and never `replay: 'safe'` on a shell tool.

Update the docs in the same change: record each decision in `docs/architecture.md` Decisions with a date, and update status rows in `docs/architecture.md` and `docs/mvp.md` when implementation lands.

Commit as you go, one logical chunk at a time: a protocol change with its tests, a backend behavior with its tests, a route. Each commit should pass the checks for what it touches, so it can be reviewed and reverted on its own. Use the `commit` skill's format (`<type>(<scope>): <summary>`, no attributions). Don't save everything for one commit at the end, and don't commit broken intermediate states. The pre-commit hook runs gitleaks, lint-staged and `pnpm lint`; fix what it reports rather than skipping it.

## 4. Verify

Run and fix until clean:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm fmt:check` (fix with `pnpm fmt`)
- `pnpm knip`
- `pnpm test`, which runs every contract, typecheck and integration test inside Docker. Each checkout gets its own Compose project, so parallel worktrees don't collide.

Never run `docker compose` directly for tests: it reads the root `.env` and can reach a real, billed E2B account. Never run `pnpm test --e2b` unless the user asks. If the change could pass in Docker and still break on a real sandbox (the Git proxy, the model path, other network hops or E2B behavior), say so under **How it was checked** instead.

## 5. Commit the rest

Commit any remaining work, such as fixes from verification, in the same format.

## 6. Open the pull request

```sh
git fetch origin rewrite
git rebase origin/rewrite   # resolve conflicts, rerun step 4 if anything changed
git push -u origin HEAD
gh pr create --base rewrite --title "<commit-style title>" --body-file <file>
```

`--body-file` skips GitHub's template, so write the body from `.github/pull_request_template.md` yourself: every heading in its order, `None.` under one that doesn't apply, and the comments replaced by your text. Fill it from your step 3 notes:

- Score **Mergeability** on the template's scale from what you verified, not what you hope. Every claim checked only in Docker, every open question and every risky change costs points.

- Write **In short** last, then reread it as the owner would, who hasn't seen the code: what is different for them, in two to four plain sentences.
- **Before you merge** lists only what the owner must do or decide. Write `None.` rather than padding it.
- **How it was checked** names the exact commands and what they showed, and what only Docker covered.
- **Before / after**: for an iOS screen, `node ios/scripts/wd.ts shot <png>` captures the Simulator. Upload images to the PR; never commit them.

## 7. Watch CI

```sh
gh pr checks --watch --fail-fast
```

On failure, read the logs with `gh run view <run-id> --log-failed`, reproduce locally when you can, fix, commit, push, and watch again. Stop after three failed rounds. Never skip, disable, or weaken a check to get green.

## 8. Report

Reply with the PR URL, the final CI status, and the PR's **Mergeability**, **In short** and **Before you merge** sections as written. Do not merge the PR or remove the worktree: a push to `rewrite` or `main` deploys both Workers.
