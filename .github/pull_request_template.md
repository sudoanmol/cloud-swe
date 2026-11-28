<!--
Keep every heading, in this order. Write "None." under one that doesn't apply, so the reader knows it was considered.
Plain words and short sentences. Define a technical term the first time it appears.
-->

## In short

<!-- Two to four sentences for someone skimming: what is different now, and why it matters. No file names, no jargon. -->

## Before you merge

<!--
What the reviewer must do or decide, as a checklist: new env vars (also in .env.example), new Worker secrets
(`wrangler secret put <NAME>`), an E2B template rebuild (`pnpm --filter server e2b:template`), a live test to run
(`pnpm test --e2b`), a decision only they can make. A merge to rewrite or main deploys both Workers.
-->

- [ ]

## Risk

<!-- Low, medium or high, then one sentence: what breaks if this is wrong, and who would notice. -->

## What changed

<!-- One bullet per change, most important first, in plain words. Name the docs updated. -->

## How

<!-- The approach in a few bullets, then what was considered and rejected, one line each. -->

## Architecture

<!-- Only when data flow, boundaries or components changed: a Mermaid diagram of the new shape. -->

## Design decisions

<!-- Each decision, linked to its dated row in docs/architecture.md. Flag any choice made for the owner that they may want to revisit. -->

## Before / after

<!-- UI: screenshots or a short recording, uploaded here, never committed. Backend: an example request and response, a log line or a timing. -->

## How it was checked

<!-- Exact commands and what they showed. Say what only Docker covered and what is unverified on E2B, real GitHub or the real model. "Tests pass" alone is not evidence. -->

## Known limits

<!-- What this deliberately doesn't do or handle, and why. -->

## Still to do

<!-- Follow-ups noticed but left out of this PR. -->

## Made by

<!-- The model and harness that did the work. -->
