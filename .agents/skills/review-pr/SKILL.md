---
name: review-pr
description: Review a pull request with the review skill, delegate approved fixes to a subagent, review until resolved, then rebase, push, merge, and clean up. Use when asked to run this PR completion workflow.
---

# Review and finish a PR

Follow this sequence. Every run, including a review-only request, completes all of Prepare (rebase onto base, environment check, migrations) before reviewing, so the review, tests, and dev servers run against current base. A review-only request ends after the findings report.

## Ground rules

These apply everywhere in this workflow.

- **Base branch.** "Base" means the PR's target branch (usually `main`).
- **Conflicts.** The parent agent resolves every rebase, merge, and stash-restore conflict itself. Never delegate conflict resolution to a subagent. Preserve both sides' intended behavior, review the resolved diff, and rerun affected checks (re-apply migrations if the rebase brought in new ones). Stop if a conflict remains unresolved.
- **Preserving dirty work.** Before any branch switch, rebase, or pull in a checkout, record its branch and staged, unstaged, and untracked changes. If it is dirty, create a named stash with `git stash push --include-untracked` and record its object ID. Afterward, restore it with `git stash apply --index <id>`, even if the operation failed. Drop only that stash, and only after verifying all work and staging state are restored. Preserve other stashes and ignored files. Never use a hard reset, forced checkout, or `git clean`.
- **Force pushes.** Record the remote PR head when you fetch it. Push rewritten history only with `--force-with-lease=<branch>:<recorded head>`. If the remote moved, inspect the new commits before retrying.
- **Secrets.** Refer to environment variables by name only. Never print values, invent credentials, or commit `.env` files.
- **Missing skills.** If the `review` or `commit` skill is unavailable, report the missing dependency and stop at that point.

## Prepare

1. Identify the PR, its base and head branches, remotes, and checkout or worktree. Run `git status` and note unrelated changes to preserve.
2. Read the repository instructions and the `review` skill.
3. Fetch the base and record the remote PR head. If the PR branch is behind base, rebase it now (ground rules apply), before checking the environment, migrating, running tests, or starting servers. This step is not optional. Do not push yet.
4. Compare the PR's environment requirements, `.env.example`, and environment validation with the worktree's `.env`. Tell the user which new variables are needed and why. If required values are missing, wait for the user to set them or authorize documented defaults. Preserve existing settings.
5. Read the migrate script in `package.json` (currently `bun run db:migrate`) and `docs/local-backend.md`. Confirm the target is the intended local development database and meet any prerequisites, then run it from the PR worktree. Never migrate production or reset data to fix an error. If configuration, prerequisites, or migrations fail, report the blocker and stop.

## Review

1. Run `review` read-only on the full PR diff against base. Establish intended scope from the PR description and linked requirements. Trace affected callers and tests, and flag changes outside that scope.
2. Report actionable findings by severity: file and line, triggering behavior, impact, and smallest useful fix. Separate bugs from optional cleanup. State the validation performed and any gaps. If no fixes are needed, say so.

## Agree on next steps

1. Ask the user whether to proceed through merge and cleanup. Reuse any authorization already given.
2. **If there are no fixes,** skip to Rebase, push, and merge once authorized.
3. **If there are fixes,** ask in the same request as step 1 which fixes to apply. Then decide who implements them, based on the number of approved fixes:
   - **5 or fewer:** the parent implements them directly. No subagent is needed.
   - **More than 5:** use an implementation subagent. Check that the environment supports subagents; if it does not, stop after the findings report and explain that this many fixes needs one. Otherwise, ask which model and reasoning effort to use for it, in the same request when you can. Use only settings the environment supports; if a choice can't be applied, say so and ask again rather than substituting.

## Implement and re-review

1. **Parent implementing (5 or fewer fixes):** make the approved fixes, touching only the affected files and preserving others' changes, and run relevant checks. Skip to step 3.
2. **Subagent implementing (more than 5 fixes):** launch a subagent with the approved findings, PR context, checkout path, repository instructions, and required validation. Give it explicit ownership of the affected files and tell it others may be working in the repo, so it must preserve their changes. It must not commit, push, merge, or clean up. Require it to finish the fixes, run relevant checks, and report changed behavior, validation results, and unresolved issues.
3. Inspect the actual diff and check results; don't treat a completion report, the subagent's or your own, as proof. Run `review` on the fixes and their effect on the full PR.
4. Fix remaining concrete findings the same way they were implemented (yourself, or by sending them back to the same subagent), rerun affected checks, then review again. Repeat until no actionable findings remain in the approved scope and required checks pass. After 3 rounds without resolution, or if work needs a scope change, missing access, or a user decision, report the blocker and wait. Keep out-of-scope optional work separate.

## Rebase, push, and merge

1. Commit the approved fixes following the `commit` skill and repo conventions, including only task changes.
2. Fetch base. If it has advanced since preparation, rebase onto it and rerun affected checks (ground rules apply).
3. Push once. Use a plain push if history was not rewritten since the recorded remote head; otherwise use the force-with-lease rule.
4. Confirm required CI passes on the latest PR head and merge requirements are met. Merge the reviewed head with an allowed method. If the head changed, review the new commits first. Don't bypass protections or treat a queued merge as completed.
5. Confirm the hosting service reports the PR as merged.

## Sync and clean up

1. **Local main.** In the main checkout: if it is dirty on a branch other than `main`, leave it untouched and report that local sync is blocked. Otherwise switch to `main` if needed (ground rules for dirty work apply) and pull with `--ff-only`. If divergent commits or unresolved restore conflicts remain, report them and stop cleanup.
2. **Environment (worktree only).** Append variables added for this task from the PR worktree's `.env` to the main checkout's `.env`, only where missing. Adapt worktree-specific values (database URLs, ports, paths) rather than copying them. If a value conflicts or needs a decision, keep the existing value and ask the user. Verify the additions before removing the worktree.
3. **Worktree.** If one was used, leave it and remove only that worktree after confirming it has no uncommitted or untracked work.
4. **Branches.** Delete the task's local and remote branches if they still exist, after verifying the remote has no unmerged commits. For squash or rebase merges, confirm the PR is merged and all local work was included before deleting a branch Git doesn't recognize as merged. Never delete `main`, the base branch, another task's branch, or a dirty worktree.

## Report

Concisely report the PR link, fixes, validation, migration result, merge result, environment variable names added / already present / unresolved, and any unfinished sync or cleanup.