# E2B end-to-end driver

Uses the product over its public API the way a client would, with a real model and real E2B sandboxes. It's billed, and it kills the sandboxes it creates.

```sh
cd server
pnpm build:test
node --env-file=../.env ../experiments/e2b-e2e/run.mjs            # local Worker; Git stages skipped
node --env-file=../.env ../experiments/e2b-e2e/run.mjs --deployed # deployed Worker; adds the Git and network-secrets stages
```

The `network-secrets` stage makes an `e2e-net` environment with a variable and a dummy network secret for `httpbin.org` and `api.openai.com`, probes curl, Node `fetch`, Python `requests`, the `openai` SDK, a stream and the 403 for an unlisted host, then deletes the environment. Truncation stays proven by the spike (`experiments/network-secrets/round14.mjs`).

Flags: `--only a,b` runs named stages, `--no-idle` skips the 11-minute auto-pause wait, and `--long` adds a 70-minute command. Each run appends to `results.log`.

The Git stages write to `sudoanmol/cloud-swe-e2e`, a public throwaway repo, on scratch branches and a PR that merges only into a scratch base. Don't point them at `sudoanmol/bubbles`, whose history is kept clean. The GitHub App must be installed on the throwaway repo.
