---
name: deslop
description: Remove AI-generated code slop and clean up code style
---

# Remove AI code slop

Check the diff against the branch's base (`rewrite` unless the user names another) and remove AI-generated slop introduced in the branch.

## Focus Areas

- Extra comments that are unnecessary or inconsistent with local style. Keep the required `Path:`/`Used by:`/`Purpose:` file headers and keep them accurate.
- Defensive checks or try/catch blocks that are abnormal for trusted code paths. Keep validation at trust boundaries: request bodies, provider and GitHub responses, and anything read back from a sandbox.
- Casts to `any`, or `as` assertions used only to bypass type issues. An assertion this repo keeps needs its safety comment.
- Deeply nested code that should be simplified with early returns
- Hand-rolled code for something an existing dependency already does (Effect, Zod, Hono, Pi)
- Other patterns inconsistent with the file and surrounding codebase

## Guardrails

- Keep behavior unchanged unless fixing a clear bug.
- Prefer minimal, focused edits over broad rewrites.
- Run `pnpm lint` and `pnpm typecheck` after editing; the anti-slop lint rules catch more of the same.
- Keep the final summary concise (1-3 sentences).
