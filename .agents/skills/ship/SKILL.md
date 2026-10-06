---
name: ship
description: Take one task from a prompt to a pull request with passing CI. Use when asked to ship, finish, or complete a task end to end and open a PR, usually from a fresh worktree session.
argument-hint: "What should the agent build or fix?"
---

# Ship

Finish one task in the current worktree, open a pull request, and watch CI until it passes.

At any step, if you need a question answered or a requirement clarified, ask the user and wait for the answer. Do not guess at behavior, scope, or product decisions.

## 1. Confirm the task

Treat the arguments as the task. If they are missing or too vague to act on, ask what to build and stop until the user answers. Do not invent work.

## 2. Prepare the worktree

- Run `git status` and preserve unrelated changes.
- `.env` is gitignored, so new worktrees lack it. If it is missing, copy it from the main checkout and never commit it:

  ```sh
  cp "$(git worktree list --porcelain | awk 'NR==1 {print $2}')/.env" .env
  ```

- Run `bun install`.

## 3. Implement

Read `AGENTS.md` and the contracts it points to for the area you touch, then make the change. Keep to the task. Write down anything out of scope for the PR body instead of doing it.

## 4. Verify

Run and fix until clean:

- `bun run check-types`
- `bunx oxlint`
- `bunx oxfmt --check <changed files>` (fix with `bunx oxfmt --write <changed files>`)
- `bun test <test file>` for each test covering changed behavior

Leave `bun run test:db` and `bun run test:backend` to CI. They restart the local Postgres and Temporal that other worktrees share. Never run paid tests.

## 5. Commit

Commit the work in the `commit` skill's format (`<type>(<scope>): <summary>`, no attributions).

## 6. Open the pull request

```sh
git fetch origin main
git rebase origin/main   # resolve conflicts, rerun step 4 if anything changed
git push -u origin HEAD
gh pr create --base main --title "<commit-style title>" --body-file <file>
```

The PR body has these sections:

- **Summary**: what changed and why.
- **Test locally**: exact commands and what to click or call. If the branch adds a migration, say so and suggest a separate database: `POSTGRES_PORT=5433 docker compose -p cloud-swe-<name> up -d --wait` with a matching `DATABASE_URL`. Also mention new env vars if any to be added.
- **Out of scope**: follow-ups you noted.

## 7. Watch CI

```sh
gh pr checks --watch --fail-fast
```

On failure, read the logs with `gh run view <run-id> --log-failed`, reproduce locally when you can, fix, commit, push, and watch again. Stop after three failed rounds. Never skip, disable, or weaken a check to get green.

## 8. Report

Reply with the PR URL, the final CI status, and anything unresolved. Do not merge the PR or remove the worktree.
