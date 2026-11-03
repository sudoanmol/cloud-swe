---
name: review
description: Review code, audit test cases, and remove useless tests. Check correctness, bugs, over-engineering, dead code, simplification opportunities, and AI-generated slop. Use when asked to review code, a diff, a branch, a pull request, or test quality.
---

# Review

Review the requested code. Unless the user requests a read-only review, remove test cases proven to add no meaningful protection under the audit rules below. Report other findings without editing production code unless the user asks for fixes.

## Scope and evidence

- Follow the user's scope. If none is given, review uncommitted changes, including staged and untracked files. If there are none, review the current branch against its base (`rewrite` unless the user names another). Ask for a target if neither provides a meaningful diff.
- Read `AGENTS.md`, the docs it points to for the area touched, and surrounding code before judging a change. Trace affected callers, data flow, and relevant tests beyond the diff.
- Verify suspected bugs with a concrete failing scenario or a focused check when practical. Distinguish confirmed findings from uncertainty. Never claim checks ran when they did not.

## What to check

- Correctness and bugs: broken behavior, regressions, edge cases, invalid assumptions, error handling, security, and data loss. Flag test gaps when they leave a specific behavior unverified.
- Over-engineering: unnecessary abstractions, dependencies, configuration, speculative flexibility, and duplicated logic. Check whether existing dependencies or a new high-quality dependency can replace custom code and reduce LOC and overall complexity without sacrificing quality or UX.
- Simplification: existing helpers, standard library or native features, fewer branches, clearer data flow, and smaller implementations that preserve required behavior.
- AI slop: redundant comments, boilerplate, inconsistent style, unjustified defensive checks, swallowed errors, type escapes, generic naming, and inflated documentation.

Judge code against actual requirements and local conventions. Do not infer authorship from style or manufacture findings to fill a checklist. Preserve validation at trust boundaries, necessary error handling, security, and accessibility when suggesting deletions.

For dependency-based simplifications, inspect existing packages and their documented capabilities first. Consider a new dependency when it removes enough custom code and maintenance to justify its cost. Assess maintenance activity, API fit, reliability, security, licensing, and runtime or bundle impact. Explain what code it replaces and the net complexity reduction, including integration and configuration. Preserve behavior, accessibility, performance, and UX.

## This repository

Check these on top of the general list. `pnpm lint` enforces some of them; report what it can't see.

- **Boundaries** (`AGENTS.md`): no Git or model credential, and no network secret, enters a sandbox's files, env vars, commands or template; no API returns a stored key; no platform credential reaches a log, result or Pi record.
- **No blind re-execution:** an unknown command outcome is not success. A shell tool is never `replay: 'safe'`, and nothing reruns a command because a request failed.
- **One authority per engine session:** nothing lets two runtimes drive the same conversation.
- **Layout:** one concern per file, at most 500 lines (tests exempt); server folders import one way (`workspaces`, `sandbox`, `git`, `tools`, `sessions`); headers' `Used by:` matches the real imports; API errors only in `API_ERRORS` in `server/src/errors.ts`, with plain messages and no upstream text.
- **Build order:** protocol changes in `protocol/` come with their tests before the server code that uses them.
- **Docs in the same change:** a new decision is recorded with a date in `docs/architecture.md` Decisions, and status rows in `docs/architecture.md` and `docs/mvp.md` match what landed. Flag stale or contradicting docs.
- **E2B, not Docker:** Docker is a test double. Flag claims that a change works on E2B when only Docker tests cover it, and changes to the Git proxy, model path or E2B behavior that need `pnpm test --e2b` before merge.
- **Scope:** work that promotes V1 or backlog items ahead of the priorities in `docs/mvp.md`.

## Dead code

Check for unused files, exports, dependencies, unreachable branches, and obsolete helpers. Trace references and real entry points before declaring code dead. Account for dynamic imports, framework conventions, generated code, scripts, Worker entry points and bindings in `server/wrangler*.jsonc`, and public APIs consumed outside the repository.

This repo has Knip configured (`knip.json`), so run `pnpm knip` without asking. Treat its output as leads, verify each finding, and avoid suppressing real issues just to get a clean report. Report confirmed dead production code unless fixes are authorized.

## Audit test cases

Audit tests within the review scope and overlapping coverage. Read the full test, the production behavior it exercises, related callers, CI routing, and relevant history before judging its value.

For each new or changed test, and each existing test flagged for cleanup, answer:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression would make it fail?
3. What does it catch that existing coverage does not? Prefer extending an existing case over duplicating the same proof. Tests at different layers need distinct failure modes.
4. Does it require an export, flag, wrapper, or injection hook used only by tests? Prefer testing through the real production entry point when that preserves meaningful coverage.

Look for:

- Assertion-free coverage probes, self-comparisons, and expected values computed by the code under test.
- Source or import greps, copied manifests, broad snapshots, and private call-shape assertions that merely restate implementation or break under behavior-preserving refactoring.
- Duplicate scenarios, repeated setup, and tests that keep otherwise dead production code or test-only hooks alive.
- Mocks that supply the behavior being asserted, fixtures that preconstruct outcomes the production path should produce, or assertions against storage the path never writes.
- Negative cases that pass because an unrelated guard rejects the input, and test names that promise behavior the inputs and assertions never exercise.

Treat these patterns as candidates, not automatic deletion rules. Keep independent API, protocol, configuration, storage, security, platform, release, and architecture checks. Keep ordering assertions when order is observable. Source inspection can be valid when it guards a real external contract and survives identifier-only refactoring. Slow or static alone does not make a test worthless. Fault-injection tests for crashes, lost receipts and restarts protect the recovery rules even when they look redundant; keep them unless another test injects the same fault.

Before removing a test, establish its name and location, the failure it detects, relevant history, non-test callers of any associated hook, stronger remaining coverage or why none is needed, cleanup it enables, risks, and a focused validation command. If evidence is missing, leave it in place and state the uncertainty. A failing baseline test may expose a product bug.

Delete proven no-op tests, tautological assertions, tests that only prove their mocks, and duplicates with no distinct failure coverage. Remove setup and test helpers made unused by those deletions. Keep cleanup within the review scope; report production hooks that could be removed separately unless production fixes are authorized. Do not replace deleted slop with another test that restates the implementation or optimize for deletion counts.

For bug regressions, verify that the test fails on pre-fix code for the intended reason and passes after the fix when practical. Otherwise report that this was not verified. After cleanup or requested fixes, run the smallest relevant checks: `pnpm lint`, `pnpm typecheck`, and `pnpm test` (Docker). Never run `docker compose` directly, and never run `pnpm test --e2b` unless the user asks, because it is billed. Inspect the final diff for unintended coverage loss.

Adapted from [OpenClaw's test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md).

## Report

List actionable findings by severity, with correctness and security issues first. For each, give the file and line, the concrete problem, its impact or triggering scenario, and the smallest useful fix. Label optional simplifications separately from bugs.

Keep the report concise. Summarize tests removed and why their deletion preserves meaningful coverage. If there are no actionable findings, say so. State what was checked and any material gaps in verification.
