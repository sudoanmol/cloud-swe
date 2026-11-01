# Herdr attach evidence

Evidence that a Claude Code or Pi session in Herdr can be driven from another device, in both directions. It isn't part of the app, and `pnpm test`, lint and knip don't run or check it.

`run.cjs` starts real Claude Code and real Pi in panes of an isolated Herdr session, then drives them only through Herdr's CLI, standing in for a future bridge and phone app. `fake-model-api.mjs` is a scripted model API on localhost. `results.log` is the captured output, with local paths removed.

**Last run, 2026-11-01:** 34 of 35 checks passed, with Claude Code 2.1.316, Pi 1.4.0 and Herdr 0.9.5.

| Flow | Claude Code | Pi |
| ---- | ----------- | -- |
| Herdr finds a session started by hand | Yes | Yes |
| A message from the "phone" appears in the terminal, with its reply | Yes | Yes |
| A message typed in the terminal reaches what the phone reads | Yes | Yes |
| Start from the phone, continue in the pane with no resume, back to the phone | Yes | Yes |
| Reply while it's being written | From the screen; the transcript gets the whole message at the end | Every token, through an extension |
| Approve and deny | Yes | Not tested |
| Interrupt | Yes | Not tested |

**The failed check is a real problem:** text half-typed in the terminal merges with a message from the phone, on both agents. The Pi run logs this without counting it as a check.

**What this doesn't prove:**

- No real login or real model. It uses a dummy token and a fake API, and no bridge or phone was involved.
- "Typed on the Mac" is simulated with `pane send-text`, and "shows on the Mac" means reading the pane's screen, with no person watching.
- The fake API can't read Claude's first message, so its first reply is `REPLY-TO[]`. Those checks confirm a reply arrived, not its text.

**To run it:** `node run.cjs` from this folder. It needs `herdr`, `claude` and `pi` on your Mac, and Herdr's Claude and Pi integrations installed. It needs no login, spends nothing, and uses only a Herdr session named `cswe2e`, which it stops and deletes. Your default session isn't touched. Run it outside Claude Code if you can, because inherited environment variables can change how Claude behaves.
