# AGENTS.md

## Project Overview

This project is a Devin-like cloud coding agent platform. Users connect a Git repository, start an agent thread, disconnect at any time, and later return to the same thread while the agent continues running or resumes from durable state.

The core product goal is to provide a persistent cloud Linux computer that an AI coding agent can fully operate: edit files, run shell commands, use Docker, start dev servers, open Chromium, visually inspect apps, and interact with the desktop through computer-use tooling.

This is primarily a portfolio/resume project, so favor a clean, production-minded architecture without unnecessary enterprise complexity.

## Core Architecture

- **Frontend:** Nuxt + Vue
- **API / control plane:** Fastify + TypeScript
- **Agent runtime:** Node.js + Pi Coding Agent SDK
- **Workflow orchestration:** Temporal
- **Database:** PostgreSQL
- **DB access:** Drizzle
- **Validation:** Zod
- **Realtime:** SSE
- **Ephemeral fanout / presence:** Redis or Valkey
- **Sandbox provider:** Freestyle Linux VMs (https://www.freestyle.sh/)
- **Computer use:** CUA Driver inside the sandbox
- **Artifacts / large checkpoints:** Cloudflare R2
- **Git auth:** GitHub App with credentials brokered server-side
- **Model auth:** credentials stay server-side and are routed through the backend/model gateway
- **Observability:** OpenTelemetry + structured logs; Sentry may be used for application errors

## Important Design Model

Treat these as separate concepts:

- **Thread:** durable user conversation/task; may live for days or months.
- **Run:** one active period of Pi agent execution.
- **Workspace:** the Freestyle VM associated with a thread.
- **Connection:** disposable browser SSE connection.

A browser connection must never own an agent run.

A worker process must never be the source of truth for a thread.

## Agent Runtime

Run the **Pi Coding Agent SDK on backend agent workers, not inside the sandbox**.

The Freestyle VM is only the agent's computer. Pi interacts with it through remote tools/adapters for operations such as:

- shell execution
- file read/write/edit
- directory listing/search
- process management
- public port exposure
- computer-use actions

Normalize Pi SDK events into project-owned event types instead of exposing Pi's event schema directly.

Persist enough Pi session state to reconstruct a thread on another worker after a crash, deployment, or long idle period.

## Sandbox Requirements

Freestyle is the primary sandbox provider.

Each workspace must behave like a normal Linux development machine and support:

- Ubuntu Linux
- root access and systemd
- Docker and Docker Compose
- arbitrary package installation
- background services
- public HTTPS previews
- X11 desktop
- Chromium
- Xvfb + Openbox/XFCE
- D-Bus + AT-SPI
- x11vnc / noVNC
- CUA Driver
- pause/resume
- reusable snapshots

Use a reusable preconfigured **golden snapshot** containing the common development and desktop stack. It must contain no user, model, GitHub, Freestyle, or other upstream credentials.

The snapshot is an optimization, not a source of truth. Freestyle Free currently applies a 30-day unused-resource deletion window, so all required machine setup must remain reproducible from project-owned configuration/scripts.

## Sandbox Lifecycle

Prefer:

1. create workspace from golden snapshot
2. clone/prepare the user's repository
3. run the agent
4. when the agent becomes idle, wait a short grace period
5. pause the VM
6. resume it when the user returns
7. eventually delete abandoned workspaces

Freestyle pause/resume preserves disk, processes, and RAM state. Stop/start preserves disk but not process memory.

Do not rely on a sandbox existing forever. Durable thread state must live outside Freestyle.

## Computer Use

CUA Driver runs inside the VM and is the preferred provider-neutral computer interface.

The agent should be able to:

- capture screenshots
- inspect windows
- move/click the mouse
- type
- scroll
- open Chromium
- inspect and interact with localhost apps
- visually verify work it produced

noVNC may be exposed to the frontend so a human can watch the same desktop. Prefer view-only mode initially.

Use X11 rather than depending on Wayland-specific behavior.

## Realtime and Reconnection

Use **SSE** for the agent event stream.

Every durable thread event must receive an ordered, persistent ID before clients depend on it.

Clients reconnect with a cursor such as `after=<last_event_id>`:

1. replay missed events from PostgreSQL
2. then tail new events in realtime

Redis/Valkey is only an accelerator for live fanout. PostgreSQL is the durable event source.

This must support:

- closing the browser while a run continues
- reconnecting minutes later and catching up
- multiple clients watching the same thread
- eventually consistent, ordered views across clients

Do not use WebSocket connection state as the source of truth.

## Durable Data Model

Expected core entities:

- `users`
- `repositories`
- `threads`
- `workspaces`
- `runs`
- `messages`
- `thread_events`
- `agent_checkpoints`

Enforce:

- at most one workspace-mutating active agent run per thread
- idempotent user message submission via client-generated IDs
- durable ordered event IDs
- explicit run states and workspace states

## Temporal

Use Temporal for durable orchestration and lifecycle state, not high-volume streaming.

Temporal should coordinate events such as:

- new user message
- start/resume workspace
- start agent run
- run completed/failed/cancelled
- idle timer
- pause workspace
- recovery after worker failure

Do **not** put token deltas, stdout chunks, or every Pi event into Temporal.

## Credentials and Security

No upstream credentials should exist inside the sandbox.

Keep server-side:

- model provider API keys
- GitHub App credentials/tokens
- Freestyle API credentials
- application secrets

Git operations requiring private credentials should be brokered through the backend rather than exposing long-lived credentials to the VM.

Assume sandbox code is untrusted.

Never place secrets in the golden snapshot.

## Public Demo Constraints

This project is intended to remain available as a public demo at near-zero cost.

Apply conservative limits such as:

- GitHub authentication before launching compute
- low global concurrency
- one active sandbox per user
- short idle pause window
- bounded active session duration
- cleanup of abandoned workspaces
- no uncontrolled paid overages

Freestyle Free provides recurring monthly compute/storage/transfer allowances and currently hard-stops new usage when exhausted rather than silently charging.

## Engineering Priorities

Prioritize, in order:

1. durability and recovery
2. sandbox isolation and credential safety
3. correct thread/run/workspace lifecycle
4. reconnectable realtime streaming
5. reliable remote tool execution
6. computer-use reliability
7. polished Devin-like UI
8. provider abstraction where it remains simple

Keep abstractions practical. The project should demonstrate strong backend/distributed-systems design without turning into a framework for its own sake.
