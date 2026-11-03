# Infrastructure decisions

Draft started 2026-10-31; your answers recorded the same day. The decisions here are final unless marked otherwise.

This covers what surrounds the agent: credentials, secrets, env vars and port URLs. Edit it freely. When a decision is accepted, move it to the decisions table in [`architecture.md`](architecture.md) and update [`mvp.md`](mvp.md). Until then, a proposal here is not a rule, and `architecture.md` still describes the current system.

## How to read this

| Status       | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| **Decided**  | You decided it, or it's built and nobody has proposed changing it |
| **Proposed** | My recommendation; you haven't accepted it                        |
| **Open**     | Needs an answer or a check before it can be decided               |

## At a glance

| #   | Topic                                 | Status  | Position                                                                                         |
| --- | ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| 1   | What we're defending against          | Decided | Accidents and bad dependencies first, not only prompt injection                                  |
| 2   | The "no credentials in sandbox" rule  | Decided | Four tiers of credential replace the absolute rule                                               |
| 3   | Anthropic API key for Pi              | Decided | Stays in the Worker and `Credentials` DO                                                         |
| 4   | Git access                            | Decided | Keep the Git proxy                                                                               |
| 5   | GitHub's 429s                         | Decided | Stay on Cloudflare with the retry; move to EC2 or DigitalOcean only if it becomes a real problem |
| 6   | Which agents run where                | Decided | Pi only, in the Worker, with tools in the sandbox                                                |
| 7   | Why Claude Code isn't in the cloud    | Decided | Anthropic's terms, and no token we'd be happy to place there                                     |
| 8   | Environments and secrets              | Decided | Named environments with two types: normal secrets and network secrets                            |
| 9   | How network secrets reach the outside | Decided | A Worker base-URL proxy, like the Git proxy                                                      |
| 10  | Port URLs across sessions             | Decided | One canonical URL per repo and port; a Worker proxy pins each browser, on your domain            |
| 11  | User snapshots, restore and fork      | Decided | Low priority, not scheduled                                                                      |
| 12  | Which work continues during the hold  | Decided | Proxy and infrastructure work counts as fixes                                                    |
| 13  | Sandbox provider                      | Decided | E2B only, tested 2026-11-01; Boat removed 2026-11-02                                             |

## 1. What we're defending against

**Status: Decided 2026-10-31.** You accepted this ranking.

Local agents can already reach your whole machine, so why bother in the cloud? Local isn't a safe baseline; it's a risk you've accepted while you're usually present. Cloud runs differ because they're unattended, run in parallel, and read untrusted web pages for hours.

Prompt injection alone wouldn't justify this work. These risks, in the order I'd rank them, do:

| Risk                          | Example                                                                                        | Does model resistance help?  |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| Accidents                     | On 2026-10-31 I printed most of the GitHub App private key while trying to list variable names | No                           |
| Agents working around a block | A stuck agent that has a token in reach uses it with `curl`, or force pushes                   | Partly                       |
| Malicious dependencies        | A `postinstall` script reads the environment and sends it out                                  | No                           |
| Prompt injection              | A web page, issue or README tells the agent to send out a secret                               | Yes, by an unmeasured amount |
| Custody                       | A secret ends up in a transcript, log, record or snapshot                                      | No                           |

Separate two harms, as the original repo's research does:

- **Theft:** the value leaves the sandbox and works after the session ends.
- **Misuse:** something uses the credential's powers during the session.

Keeping a value out of the sandbox stops theft, not misuse. Scoped, restricted keys help with both.

## 2. The "no credentials in sandbox" rule

**Status: Decided 2026-10-31.**

The absolute rule would be false for any secret a program must read directly. These tiers replace it:

| Tier                 | Examples                                | Rule                                            |
| -------------------- | --------------------------------------- | ----------------------------------------------- |
| Platform credentials | Model API key, GitHub token             | Stay out of the sandbox                         |
| Network secrets      | Stripe, OpenAI, or any header-based key | Never enter the sandbox (see 8 and 9)           |
| Normal secrets       | Database URL                            | Enter only when the chosen environment has them |

## 3. Anthropic API key for Pi

**Status: Decided, built.** The key stays in the `Credentials` DO or a Worker secret, because Pi runs in the Worker. Keeping it out of the sandbox costs nothing.

## 4. Git access

**Status: Decided, built and proven live.** Keep the Git proxy.

Its main value is enforcing limits rather than hiding a token: no pushes to `main`, no force pushes, and approvals. It also means a token-stealing worm finds no Git credential in the sandbox.

Live proof on 2026-10-31 through the deployed Worker: private clone of `CSE434_Socket_Project`, then push and draft PR on `bubbles` ([#3](https://github.com/sudoanmol/bubbles/pull/3), closed, unmerged).

## 5. GitHub's 429s

**Status: Decided 2026-10-31** (the order). GitHub refuses a share of the Worker's requests to `github.com`, even with a real token.

Probe on 2026-10-31 from Cloudflare, 16 rounds, one round every 30 seconds:

| Address                | 429s  |
| ---------------------- | ----- |
| Sign-in (invalid code) | 6     |
| Git, no token          | 9     |
| **Git, real token**    | **7** |
| Web page               | 9     |
| `api.github.com`       | 0     |

The cause is unconfirmed. Cloudflare's shared outbound IPs are my best guess. Sign-in already retries for about 90 seconds.

The same probe on 2026-11-01, with no token and a dummy sign-in client, got **no 429s in 16 rounds** from both an EC2 instance in `us-east-2` and a Mac. That supports the shared IP theory, but it's one address each, at a different time from the Cloudflare run.

Order, stopping at the first that's good enough. Step 1 is the decision for now. Later steps apply only if 429s become a real problem, and step 2 still needs your explicit go, because it breaks the platform tier in section 2:

1. **Retry in the Git proxy (chosen).** Built, uncommitted and not deployed: only on a 429, for about 60 seconds. Bodies up to 32 MiB are held so they can be re-sent; a larger push gets one try. Tested against the fake GitHub only, so how much it helps on real GitHub is unmeasured.
2. **A 1-hour, one-repo token in the sandbox, plus GitHub rulesets on `main`.** Git then talks to GitHub from the sandbox's IP. This loses the approval flow and breaks the platform tier in section 2, so it needs your explicit choice.
3. **The proxy on a fixed-IP host such as Railway.** This adds a service for you and every self-hoster, tokens leave the Worker, and the push policy would need to call back into it. Railway's outbound IP may also be shared unless you pay for a static one; I haven't checked.

## 6. Which agents run where

**Status: Decided 2026-11-01.**

Sessions run Pi. Its loop runs in the Worker, with model access through an API key held by the Worker and `Credentials` DO; only tools execute in the sandbox.

There's no Claude runner on a sandbox, no `claude setup-token` stored by the app, and no Claude credential in the cloud. This replaces the 2026-10-31 decision to store a `setup-token` and inject it per run.

## 7. Why Claude Code isn't in the cloud

**Status: Decided 2026-11-01.** Claude Code doesn't run in sandboxes, and none of the options below is used: a subscription there forces a choice between a terms risk and an exposed token.

Anthropic's [legal page](https://code.claude.com/docs/en/legal-and-compliance) says developers "may not collect, store, or intermediate Claude.ai credentials or session tokens", and that sign-in "must complete through Anthropic's own flow". It also allows "an end user signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code", and managing your own API keys. Anthropic may enforce "without prior notice". This is my reading, not legal advice.

| Option                          | Terms                                     | Token                                                                                | Outcome             |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ | ------------------- |
| Sign in inside the sandbox      | Directly covered by the "allowed" text    | In a file code in the sandbox can read, and on the provider's disk and paused memory | Available if needed |
| API key behind a Worker gateway | Clearly allowed                           | Stays out of the sandbox; a theft can't happen through it                            | Available if needed |
| `setup-token` stored by our app | Grey: close to "store" and "intermediate" | Readable in the sandbox, valid up to a year                                          | Rejected            |
| Provider injection (E2B)        | Most likely to break the terms            | Provider holds and intermediates it                                                  | Rejected            |

**Revisit if** you want Claude Code running in the cloud. Use the API-key gateway, or sign in inside the sandbox and accept the exposure. On E2B that sign-in starts without a browser: `claude auth login` prints the link and waits for a code, though no real sign-in was completed.

**What testing showed, 2026-11-01,** with Claude Code 2.1.316, a dummy token and a fake model API, so no real credential was involved:

| Check                                      | E2B                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) | Bash runs, but a dev server dies with its call, and `sudo`, Docker and home writes fail |
| Token readable through `/proc` without it  | Yes                                                                                     |
| Token in command text saved by provider    | Yes, logs API                                                                           |
| Per-command env saved by provider          | **Yes**, logs API; create-time env, files and stdin weren't                             |
| Provider injection                         | Works with Claude Code and a placeholder token; real Anthropic API not tested           |

## 8. Environments and secrets

**Status: Decided 2026-10-31.** Mimic Claude Code's cloud environments, with no extra layers.

- A user creates **named environments** in the client and picks one for each session request.
- The default environment is empty: no secrets of any kind.
- An environment holds exactly two things:

| Type               | Examples      | Who can see the value                         | Who can change it                                                | Reaches the sandbox? |
| ------------------ | ------------- | --------------------------------------------- | ---------------------------------------------------------------- | -------------------- |
| **Normal secret**  | Database URLs | The client, the agent and code in the sandbox | The client and the agent; agent edits show in the client at once | Yes                  |
| **Network secret** | API keys      | The client only                               | The client                                                       | Never                |

**How an agent gets a network secret:**

1. The agent asks for one.
2. The client shows the request, and the user sends the value.
3. It's added to the environment automatically.
4. Our proxy swaps it in once the request leaves the VM. The sandbox only ever has a placeholder.

Dropped on 2026-10-31: the four-layer proposal, including default install hardening.

**Decisions on the details:**

- **Setting a network secret:** you can set one in an environment yourself, or the agent can suggest one when a session needs it. Either way you assess it and enter the value. The agent never reads the value, though it can still use the secret through the proxy on the hosts you confirmed.
- **Allowed domains:** the agent suggests them, the client shows them plainly and you confirm. Otherwise an injected agent could ask for your Stripe key with `allowed domain: evil.com`.
- **Redaction:** none for normal secrets. The agent can read and edit them, so its view can't be hidden. Treat them as visible to the model and transcript, and only use dev-only values. Anything sensitive that travels in a header should be a network secret. A database password can't be one, so this is the remaining exposure.
- **Edits across sessions:** shared. The client shows one current value, with a record of which session changed it. A new value applies to later commands, so a dev server that's already running keeps the old one until restarted.
- **Storage:** encrypted in the `Credentials` DO. Network secret values can't be read back through the API, even by the client after sending them, like the model key.

**Still to settle when this is built:**

- **Delivery:** E2B keeps per-command `envs` and command text in its logs API, so normal secrets can't go per command. They'd need create-time `envs`, a file or a wrapper, which stayed out of the logs. A snapshot or paused sandbox holds whatever is in its files and memory.
- **Naming (settled 2026-11-03):** the E2B template field is now `template` (`WORKSPACE_TEMPLATES`), so "environment" means only these named sets.

## 9. How network secrets reach the outside

**Status: Decided 2026-10-31: option A.** Reviewed 2026-10-31: Tokenizer, agent-vault, microsandbox, OpenSandbox, Cloudflare Sandboxes and Docker's published write-up, from source and docs, with nothing run.

**The protection is that the secret is never in the VM,** so bypassing the proxy only sends a useless placeholder. An injected agent can still use a secret through the proxy, and can send other data anywhere. E2B's allow and deny lists, set from outside the VM, worked when tested (section 13); using them to force traffic through the proxy isn't designed.

| Option                                    | For                                                                                                                           | Against                                                                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Worker base-URL proxy** (decided)    | Same shape as the Git proxy; free; no certificates; keys stay in the `Credentials` DO; doesn't depend on the sandbox provider | Tools with hardcoded hosts don't work; HTTP only; Cloudflare's IPs may be refused, as GitHub does                                                                     |
| **C. An in-VM forward proxy on top of A** | Transparent for tools with no base URL setting                                                                                | Certificate trust is best-effort; pinned clients fail; another process to keep alive                                                                                  |
| **D. Move to Cloudflare Sandboxes**       | The only reviewed option with real outbound control and no proxy credential to steal                                          | [Smaller limits](https://developers.cloudflare.com/containers/platform/limits/), and it replaces an E2B lifecycle that's proven live. Not worth moving for this alone |
| **E. A separately hosted proxy**          | Non-Cloudflare IPs                                                                                                            | Routing is still voluntary, and it adds a service for you and self-hosters                                                                                            |

**Decision:** build A, and add C only if a real tool needs it. Tokenizer and agent-vault can't be used as they are: Tokenizer assumes a private network, and agent-vault's docs say its standalone version is no longer maintained.

**Design rules for A:**

- The route is `https://<worker>/net/<token>/<host>/...`, with the host exact-matched against the list the user confirmed.
- Keep the placeholder and the routing token separate, so a placeholder sent to the wrong host grants nothing.
- Swap the secret into one named header only. Query and body stay off by default, because they widen echo exposure.
- Refuse redirects, strip our routing data, and redact the secret from response headers.
- Scope tokens per session and revoke them when the sandbox is deleted. A stolen token allows calls to allowed hosts until then.

This differs from your "swap after it leaves the VM" in one way: code has to send requests to the Worker through a base URL setting. Claude Code cloud's and Codex's internals aren't public, so I can't say how close this is to theirs.

**Unverified:** Worker streaming and body limits on this route, and which APIs block Cloudflare's IPs.

## 10. Port URLs across sessions

**Status: Decided 2026-10-31.**

**Requirement:** one canonical URL per repo and port. You register it once with Google, GitHub or any OAuth provider, and it works for every session on that repo.

E2B's port URLs stay the same for one sandbox across a pause and resume, but two sessions get two different URLs, so this needs our own proxy.

**The catch:** if sessions A and B are both running port 3000, a request to the canonical URL can only reach one. Something has to choose.

**Design:** a Worker proxy on your own domain, which chooses per browser with a cookie.

```text
https://myapp-3000.cloud-swe.dev  ->  whichever session this browser last opened
```

1. You open a session's preview from the client.
2. The Worker sets a signed cookie on the canonical host, pinning this browser to that session.
3. Every request from that browser reaches that session, including the OAuth redirect coming back.
4. The Worker strips its cookie before forwarding, and adds E2B's access token on the way to the sandbox.

Because the URL is now guessable, the pin cookie also acts as the access check. A request without it gets refused.

**Known limits:**

- **Two tabs, one browser:** they share the pin, so the last session opened wins. Switching mid-OAuth sends the callback to the wrong session.
- **App cookies are shared:** a login cookie from session A is also sent to session B, so you may need to sign in again.
- **No cookie, no route:** webhooks and server-to-server calls are refused, unless we add an opt-in unguessable URL per session.
- **Cross-site POST callbacks:** the cookie must allow these, for example for Sign in with Apple's `form_post`.
- **Sessions with no repo:** they have no canonical name, so they'd use a per-session URL.

**Protecting a session mid-flow:** agents test through `localhost`, so they don't need the canonical URL, and they don't wait for it. The client shows which session holds a URL. If that session served requests in the last minute or so, opening another one warns that the URL will move. The Worker can see recent requests, but not whether a tab is still open, so waiting until a URL is "free" isn't possible.

**Webhooks:** a webhook is another service calling your app's server when something happens, such as Stripe saying "payment succeeded" or GitHub saying "PR opened". No browser is involved, so there's no pin cookie and the preview proxy refuses it. This only matters when you're testing an app that receives them, so the opt-in per-session URL waits until a real app needs it.

**Rejected:** numbered slots (`myapp-1-3000`), because you'd have to register several URLs. Provider subdomains, because they come from a shared namespace you don't control.

The original repo's proxy gave each thread its own slug, so it didn't provide this either. Its own parent domain is the part worth keeping: a wildcard on a provider's shared domain would also match other people's sandboxes.

**E2B facts** (tested 2026-11-01, see section 13):

- Private by default: 403 without the access token, 200 with it. HTTP and WebSocket work.
- Host and token stay the same after a resume, and processes keep running, so the app needn't be restarted.
- Auto-resume wakes a paused sandbox on a request with the token in 0.6 to 1.3 s; a request without one doesn't wake it.

**To check or decide:**

- **Domain:** decided: your personal domain for now, as a single setting, with a $10 separate domain to reconsider later. Moving would mean changing that setting and re-registering OAuth URLs. Being the only user doesn't remove the risk: previews run code the agent wrote and dependencies it installed, and those can set or receive cookies scoped to the whole domain. Before building, check that nothing you care about relies on such cookies, and that the domain is on Cloudflare, which the wildcard needs.
- Apps may build wrong callback URLs if the provider needs its own hostname on proxied requests, unless they trust a forwarded host. The agent gets the canonical URL as an env var.
- WebSocket hot reload has to pass through the Worker.
- Certificates: I recall Cloudflare's free ones only covering first-level wildcards like `*.cloud-swe.dev`.
- How a pin behaves when its session's sandbox is stopped or deleted.

## 11. User snapshots, restore and fork

**Status: Decided 2026-10-31.** Low priority, not scheduled, because finished threads aren't reopened. The design stays in `architecture.md` for reference. The 7-day idle delete stays as is.

## 12. Which work continues during the hold

**Status: Decided 2026-10-31.** Proxy and infrastructure work counts as fixes, not features. New features stay on hold.

| Work                             | Type    | Depends on       | When                                             |
| -------------------------------- | ------- | ---------------- | ------------------------------------------------ |
| Git proxy retry                  | Fix     | Nothing          | When you say go                                  |
| Docker project name per worktree | Fix     | Nothing          | Before any parallel workers                      |
| Preview proxy                    | Fix     | Section 10       | When decided                                     |
| Network secret proxy             | Fix     | Section 9        | When decided                                     |
| Environments and secrets         | Feature | Sections 8 and 9 | After the hold                                   |
| `ask_user_question` and todos    | Feature | Nothing          | Done 2026-10-31, at your request during the hold |
| Conversation tree and reversal   | Feature | Nothing          | After the hold                                   |
| Background shells                | Feature | Section 8        | After environments and secrets                   |

## 13. Sandbox provider

**Status: Decided 2026-11-01, tested the same day, adapter built.** E2B is the only provider, because this is mainly a resume project with light cloud use. Boat was removed on 2026-11-02, so the code no longer branches on provider behavior. History: Freestyle (2026-09-07), Modal (2026-09-30), Boat (2026-10-29), E2B (2026-11-01).

**Testing:** live tests run on E2B. The Docker test double mimics E2B's pause, but Docker tests don't prove E2B.

**Accepted limit:** on E2B's Hobby tier a sandbox runs for at most 1 hour without pausing, and resuming resets that. Asking for more is refused or capped. Cloud sessions run Pi, whose loop is in the Worker, so a pause drops no model connection.

**Stay off provider-only features where the Worker can do it:** network secrets go through the Worker proxy rather than E2B's injection, and port URLs through the Worker proxy.

|                                 | Cloudflare                                           | E2B Hobby                                                      | Daytona Tier 1                                                             |
| ------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Start                           | $5 a month                                           | **$100 once, no card**                                         | **$200, no card**                                                          |
| Monthly base after that         | $5, includes about 2 hours                           | $0; projects are blocked at zero credits until you add a card  | $0; pay from a wallet                                                      |
| 4 vCPU, 8 GB, per hour          | $0.11 to $0.40 (12 GiB)                              | $0.33                                                          | $0.33                                                                      |
| Maximum disk                    | 20 GB                                                | **10 GiB** (20 on the $150 Pro)                                | **10 GB**                                                                  |
| When stopped                    | Disk gone without a snapshot                         | **Files and running processes kept, with no time limit, free** | Disk kept and billed past 5 GiB, archived free after 7 days; processes end |
| Longest continuous run          | Up to 6 hours after the Durable Object goes inactive | **1 hour**, reset by pausing and resuming                      | No limit found                                                             |
| Outbound network                | Open, with interception                              | Open, with allow and deny lists                                | **Essential services only**, unless you top up $500                        |
| Secret swap outside the sandbox | Built in                                             | Built in, public beta                                          | Upstream proxy setting only; tier availability unchecked                   |
| Port URLs                       | Through your Worker                                  | Private by default; an access token is required                | Warning page, skipped by a header; token changes after a restart           |

**Daytona's catch:** on Tier 1 and 2 a sandbox reaches only listed hosts, including GitHub, npm, PyPI, Anthropic and `*.workers.dev`. A database URL in an environment wouldn't connect, which breaks normal secrets. Removing that takes a $500 top-up.

**E2B's catches:** 1 hour on Hobby means long runs must pause, which drops open connections from code in the sandbox. Per-command `envs` and command text are kept in its logs API. Overwriting a file in `/tmp` through the file API can fail. 10 GiB is enough for most repos but tight for several large ones.

No provider fixes the 429s, because the Git proxy runs on the Worker either way. Only Git sent straight from a sandbox, or a proxy off Cloudflare, avoids them.

At 10 hours a month at this size, E2B's credit lasts about 30 months and Daytona's about 60, if they don't expire first. Daytona's dashboard shows an expiration breakdown, and I couldn't find the terms for either.

**E2B test results, 2026-11-01.** Real sandboxes at 4 vCPU and 8 GB, built from an Ubuntu 24.04 template with E2B SDK 2.62.0, about 3.7 hours of sandbox time by my estimate. Claude Code runs used a dummy token and a fake model API.

| Check                      | Result                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK in the Workers runtime | Create, list by metadata, files, detached commands, pause, resume and kill all work in local `workerd`. Not yet run on deployed Cloudflare. 144 KiB gzipped alone                                                             |
| Create                     | About 1 s                                                                                                                                                                                                                     |
| Pause and resume           | 0.4 to 1.5 s and about 0.3 s, including with 6.5 GB of memory in use. Three cycles in one sandbox kept files, memory and processes, with the clock within 1 s                                                                 |
| Command supervisor         | The real supervisor from `runner.ts` keeps running through pauses, and cancellation works after a resume                                                                                                                      |
| Past 1 hour with a pause   | Paused at 50 minutes and resumed with a new 1-hour deadline. The supervisor, a dev server and Postgres in Docker were all still running at 72 minutes                                                                         |
| Hitting the limit          | A 2-hour create is refused, and `setTimeout` is capped at 60 minutes from the start. With `onTimeout: 'pause'` the sandbox pauses itself at 60 minutes and resumes intact in 0.3 s, so no separate pause timer is needed      |
| Disk                       | 10.25 GB free on a 14.25 GB disk with Docker, Chromium, Postgres, Redis, Node and build tools. Documenso plus Postgres in Docker leaves 7 GB. cal.com with its dependencies plus Postgres in Docker leaves 3.8 GB             |
| Docker                     | Containers, port mapping and image builds work, and they survive a pause                                                                                                                                                      |
| Native Postgres            | Fails to start until `ssl` is off, because its certificate is missing from `/etc/ssl/certs`. Then it works and survives a pause                                                                                               |
| Port URLs                  | 403 without the access token, and 200 with it. HTTP and WebSocket work. Host and token stay the same after a resume. Auto-resume wakes on a request with the token in 0.6 to 1.3 s, and a request without one doesn't wake it |
| Snapshot and fork          | Both work and keep files; a sandbox started from a snapshot took about 1 s                                                                                                                                                    |
| Network rules              | An allowlist blocks other hosts and IPs                                                                                                                                                                                       |
| GitHub 429s from E2B       | None in 16 rounds, one address, 8 minutes, no token                                                                                                                                                                           |
| Secret injection           | Works over HTTPS and survives a pause, but it isn't used: see section 7                                                                                                                                                       |

**What the adapter does about each catch** (built 2026-11-01, in `server/src/workspaces/e2b.ts` and `server/src/sandbox/remote.ts`):

- **Files in `/tmp`:** E2B's file API opens files as root, and `fs.protected_regular=2` stops that reopening another user's file in a sticky directory, even with `files.write` told to write as the file's owner (tested 2026-11-02). Writing as `root` works in place, keeping the inode, mode and hard links, but makes root the owner, which locks the agent out of the file. So a denied overwrite is written as root and then `chown`ed back to its owner and group. Nothing is deleted. Writes elsewhere take one request.
- **Logs:** no secrets go through per-command `envs` or command text. Create-time `envs`, files and stdin stayed out of the logs.
- **Duplicates:** there's no idempotency key on create, and the list takes up to about 0.5 s to show a new sandbox (6 measurements, 89 to 537 ms). So a lost create is found by listing on metadata, and concurrent retries in the catalog share one lookup and create. More than one match fails closed as `sandbox_creation_unconfirmed`.
- **Resume:** running processes survive, so a resume leaves open commands open. An active run's keep-alive connects instead of renewing, because `connect` both resumes a paused sandbox and raises its deadline.
- **Connecting wakes:** every file or command call connects, about 200 ms with its read, and that resumes a paused sandbox. This is what carries a polled command past the hour. Only calls that may run the sandbox reach it (a run's tools and keep-alive, a new message admitted past the cap, stopping orphaned commands), so an idle sandbox stays paused.
- **Deadlines:** `setTimeout` fails on a paused sandbox with the same error as a deleted one, so a failed renewal is checked with an inspection before anything is concluded. `connect` never lowers a deadline, and raises it to at least 5 minutes.
- **Default user and size:** the `cloud-swe` template in `server/scripts/e2b-template.ts` ends on `user` and is 4 vCPU, 8 GB. The session's `template` field names the template.

**Tested live, 2026-11-01,** with `pnpm test --e2b`, from a Worker in local Miniflare with a scripted model: the shared adapter checks, lost-create recovery, concurrent retries making one sandbox, a real session writing and editing files, a command surviving a pause under it with a message arriving while paused, the idle deadline after a run, and a background process alive after an idle pause. Treating a pause as the end of its commands makes the end-to-end test fail, so the test guards it.

**Known limits:**

- At the hour limit a sandbox stays paused until the next poll or keep-alive tick, so up to `KEEPALIVE_INTERVAL_SECONDS` if no command is being polled. Its background processes wait for that long.
- A command can be wrongly reported as lost if a sandbox paused just after its last heartbeat was read and nothing polled for 15 seconds. It's reported truthfully and never rerun, and it needs a pause inside a 200 ms window, so I've left it.
- The in-memory sharing doesn't survive a catalog restart. A retry right after one could still make a second sandbox, which fails closed, and that sandbox then sits paused until removed by hand.

**Tested through the deployed Worker, 2026-11-02,** with the real model and real GitHub, by [`experiments/e2b-e2e/`](../experiments/e2b-e2e/README.md): all 27 stages passed. It covers the E2B SDK on real Cloudflare and Git through the proxy, and the sandbox held no platform credential in its environment variables or files. A separate run took a 70-minute command past the hour limit: it ran once and its output reached the agent.

**Not tested:** E2B's Desktop sandbox, and pause failures, which the docs say can return 503.

**Disk target:** prefer installing databases directly in the template over running them in Docker.

## What other projects do

Reviewed 2026-10-31 from source and docs at each default branch; nothing was run. **None is a full Devin-style product, and none matches this design end to end.**

| Project                                                                     | What it is                                                                     | Where the agent runs  | Secrets                                                                          | Git in the sandbox                                                         | Port URLs                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| [Open-Inspect](https://github.com/ColeMurray/background-agents) (`f569ac5`) | Self-hosted background agent; closest product shape; several sandbox providers | In the sandbox        | Scoped and encrypted; sent once at sandbox create, so changes need a new sandbox | Real tokens, fetched on demand; no ref policy                              | Provider URLs; no proxy                         |
| [Open Agents](https://github.com/vercel-labs/open-agents) (`cf865e9`)       | Vercel template to fork                                                        | Outside, Workflow SDK | No model                                                                         | No token; Vercel's network policy adds headers; commits go through the API | Fixed ports on `*.vercel.run`                   |
| [Junior](https://github.com/getsentry/junior) (`e838c19`)                   | Sentry's Slack bot                                                             | Outside, Pi           | Placeholders; host-side credential swap by domain                                | Git brokered outside; writes need user authorization                       | None                                            |
| [Terragon](https://github.com/terragon-labs/terragon-oss) (`83142a1`)       | Background agent, no longer active                                             | In the sandbox        | Decrypted into the daemon's env                                                  | Long-lived user token in files                                             | None found                                      |
| [OpenHands](https://github.com/OpenHands/software-agent-sdk)                | Agent platform; cloud parts closed                                             | In the sandbox        | Injected only into commands that name them; output masked; `request_secret` tool | Token in the clone URL                                                     | Closed service in the cloud                     |
| [Coder](https://github.com/coder/coder)                                     | Dev environments with agents                                                   | Control plane         | In every workspace                                                               | Askpass fetches the token per prompt; no push limits                       | Name-derived, wildcard domain, per-port sharing |
| [opencode](https://github.com/anomalyco/opencode)                           | The agent itself                                                               | In its server         | Stored in SQLite                                                                 | Not applicable                                                             | None                                            |
| [moltworker](https://github.com/cloudflare/moltworker)                      | Personal assistant on Workers                                                  | In the container      | In process env                                                                   | None                                                                       | One port, via Worker relay                      |
| [Sculptor](https://github.com/imbue-ai/sculptor)                            | Desktop app, local worktrees                                                   | On the host           | Host env                                                                         | Host `gh` and git                                                          | Path-based, self-hosted only                    |

**This design goes further on:** a Git-boundary push policy with approvals, which none of them has, and one port URL across sessions, which none of them has either.

**They're ahead on:** a shipped product surface (Open-Inspect's UI, terminal and backends), and a built placeholder credential system (Junior).

**Borrow:**

- **Section 5:** Open Agents commits through the API rather than `git push`, and `api.github.com` had 0 of 16 429s in our probe. This could replace the token-in-sandbox fallback, but it flattens history and has size limits. If a token ever goes in the sandbox, use Coder's or Open-Inspect's on-demand fetch rather than storing it.
- **Section 8:** OpenHands' `request_secret` takes a name and reason, never a value, and returns at once, with the outcome delivered later. That matches the approval flow; add the user-confirmed domains. Its stream-safe masking is worth copying; per-command injection doesn't fit E2B, which logs per-command `envs`.
- **Section 9:** Junior's placeholders and its decrypt-only-credentialed-domains rule. Coder shipped base URLs first and a forward proxy later, the same order proposed here.
- **Section 10:** Coder's single-label wildcard (`*-apps.example.com` needs only `*.example.com`), its one-time key redirect into an HttpOnly cookie, and stripping its cookies before forwarding. Avoid path-based previews, because apps collide on one origin.

**Avoid:** tokens in remote URLs; global secrets in every workspace; limits that exist only in prompts or client-side wrappers; server-side Claude OAuth using Claude Code's client ID (Open-Inspect and Terragon do this), which looks like the "intermediate" problem in section 7.

## Moving the Git proxy off Cloudflare

**Status: Decided 2026-11-01: stay on Cloudflare with the retry.** Move to EC2 or DigitalOcean only if 429s become a real problem in your own use. An always-on server is hard to justify at light use. If it does move, it replaces the retry, and everything else stays on Cloudflare. Sign-in also gets 429s from the Worker and keeps its retry.

Monthly cost, read 2026-10-31 and 2026-11-01. Only the Git proxy moves, so normal use should be within each included transfer:

| Host                            | Monthly                                                     | Included transfer                | Notes                                                                 |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| DigitalOcean, 512 MiB           | $4.00                                                       | 500 GiB                          | IPv4 included on bundled plans                                        |
| Lightsail, 0.5 GB               | $5.00                                                       | 1 TB                             | IPv4 included                                                         |
| Fly.io, 256 MB                  | $5.79 ($2.19 machine, $3.60 static egress)                  | None; $0.02/GB                   | No free tier                                                          |
| **EC2 `t4g.nano`, `us-east-2`** | **$7.36** ($3.07 instance, $3.65 IPv4, $0.64 for 8 GB disk) | $0.09/GB past the free allowance | Credits may cover it; see below                                       |
| Railway Pro                     | $20 minimum                                                 | $0.05/GB                         | Static IP may be shared with other customers, which defeats the point |
| Hetzner, US                     | €17.99                                                      | 1 TB                             | Listed as currently unavailable                                       |

**AWS credits:** AWS's free plan gives up to $200, and "the account closes on its own 6 months after you open it or when your credits run out". I couldn't read this account's plan: it's in an organization whose policy limits regions, and the plan lookup returned no data. Confirm it before depending on it.

**Costs beyond the bill:**

- One server you patch and monitor, and when it's down, Git is down for every session.
- The proxy needs its own TLS and hostname, plus a private route to the Worker for access checks, tokens and filing approvals.
- One-hour, one-repo GitHub tokens would sit in the server's memory, outside the Worker.
- Self-hosters inherit the server.

**Evidence, and its limits:** EC2, a Mac and an E2B sandbox got no 429s in 16 rounds, where Cloudflare got them on 7 to 9 of 16 Git and web rounds. That's one address each, for 8 minutes, without a token. Run a longer probe from the chosen host before moving.

## Research still worth doing

- How much traffic really needs a retry: deploy the Git proxy retry and count what still fails.

## Immediate actions, separate from these decisions

- [ ] Generate a new GitHub App private key, because most of the current key's lines leaked into a session transcript. Update `.env` and the Worker secret.
- [x] Revoke the old PAT (you reported this done).
- [x] Delete `cloud-swe/proxy-test-58c7d61b` on `bubbles` (you reported this done).

## Sources

Read 2026-10-31 unless noted; pages may change.

- [Claude Code authentication](https://code.claude.com/docs/en/authentication), [LLM gateways](https://code.claude.com/docs/en/llm-gateway), [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [cloud environments](https://code.claude.com/docs/en/cloud-environments)
- [Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)
- The original repo: `~/Developer/cloud-swe/docs/agent-environment-competitors-research.md` (researched 2026-10-06) and `docs/backend-contract.md`, "Previews and browser"
