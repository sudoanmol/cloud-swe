# Freestyle sandbox and public repository spec

Status: approved for implementation

This document records the original sandbox and public-clone scope. The [GitHub broker contract](github-broker.md) supersedes its private-Git exclusions and anonymous-only access rules. Snapshot, checkout recovery, storage, timeout, and submodule restrictions still apply.

## Decision

Use a Freestyle Linux VM as the production workspace. Run Pi on the backend runner. The VM provides the filesystem, processes, Docker daemon, browser, and desktop that Pi controls through remote tools.

Keep a Dockerfile in the repository as a local image recipe and package manifest. Freestyle does not import a Dockerfile as a VM snapshot. Build the Freestyle golden snapshot by applying the same package contract to a clean Freestyle Ubuntu VM, verifying it, and capturing the VM with `vm.snapshot()`.

The attached design chat starts with Box and later compares Daytona with Freestyle. The repository's current implementation chooses Freestyle. Daytona and Box are not runtime providers in this slice.

## Goals

- Start a new Freestyle workspace from a versioned golden snapshot.
- Include the tools that a coding agent needs for common repositories.
- Include the browser and desktop dependencies needed for computer use.
- Accept one public GitHub repository when a user creates a thread.
- Accept an optional GitHub branch with the repository.
- Clone that repository into `/workspace` before Pi starts.
- Check out the requested branch before Pi starts.
- Reuse the checkout for follow-up messages in the same thread.
- Keep model, GitHub, Freestyle, and user credentials out of the snapshot and workspace.
- Rebuild the snapshot from repository-owned files if Freestyle removes or replaces it.
- Keep the local Docker provider available for credential-free scripted tests.

## Non-goals

- Private GitHub repositories, GitHub App authentication, and pushes.
- Commit, tag, pull-request ref, or arbitrary Git ref selection.
- GitHub OAuth or repository selection UI.
- Importing a Docker image into a Freestyle VM.
- Persisting uncommitted workspace changes after a VM is deleted.
- Exposing a public, unauthenticated desktop or Chrome DevTools endpoint.
- Claiming that Pi has visual computer-use tools before the runner exposes screenshot and input operations.

## Current implementation

The repository already has these pieces:

- `apps/runner/src/pi.ts` runs Pi on the backend and keeps provider credentials in memory.
- `apps/runner/src/freestyle.ts` creates, starts, pauses, and deletes Freestyle VMs.
- `RUNNER_EXECUTION_MODE=pi` requires `RUNNER_SANDBOX_PROVIDER=freestyle`.
- `RUNNER_EXECUTION_MODE=scripted` uses a network-disabled local Docker container.
- `FREESTYLE_SNAPSHOT_ID` selects the VM snapshot. Runtime configuration should
  use the published opaque ID recorded in `infra/freestyle/MANIFEST.md`; the
  code fallback to `freestyle/ubuntu-sm` is only a bootstrap default.
- Pi tools expose remote shell, read, write, and literal edit operations.

The current Freestyle default is a public base snapshot, not the configured golden snapshot described below. Scripted execution can use either Docker or Freestyle, depending on `RUNNER_SANDBOX_PROVIDER`. The runner implementation now stores the public repository URL and branch, then initializes the checkout before Pi starts.

## Golden snapshot contents

Build the snapshot from Ubuntu 24.04. Record the exact package and binary versions in the snapshot manifest.

### Development tools

The snapshot contains:

- Git and common Git transport tools.
- GNU coreutils `timeout` and util-linux `flock` for bounded, serialized guest execution.
- `curl`, CA certificates, `jq`, `ripgrep`, `unzip`, `file`, `procps`, `iproute2`, and `build-essential`.
- Node.js 24 with `node`, `npm`, and `npx`.
- Bun 1.4.0, matching the repository package manager.
- pnpm, with its major version recorded in the manifest.
- Python 3 with `pip`, `venv`, and `uv`.
- Go, with its version recorded in the manifest.
- Rust and Cargo, with their toolchain channel recorded in the manifest.
- Docker Engine, Docker Compose v2, and Buildx.
- A writable `/workspace` directory.

### Computer-use tools

The snapshot contains:

- Chromium.
- Xvfb.
- Openbox or another small X11 window manager.
- D-Bus and AT-SPI packages.
- `x11vnc`, noVNC, and websockify.
- `xdotool`, screenshot tooling, and the fonts required by Chromium.
- The CUA Driver at a recorded version.

The CUA Driver installation source is a required build input. The recipe must not invent a package name or download an unauthenticated binary from an unknown source. The verification script fails when the configured CUA Driver is missing.

Enable only the services that the VM needs. Bind VNC, noVNC, CDP, and the CUA control endpoint to private interfaces or protect them with an authenticated route. The snapshot must contain no browser profile, login state, API key, SSH key, Git credential, or Freestyle credential.

## Snapshot artifacts

Keep these files under `infra/freestyle/`:

- `Dockerfile`: local Docker image recipe and package manifest.
- `bootstrap.sh`: idempotent provisioning script for a clean Freestyle Ubuntu VM.
- `verify.sh`: capability checks for the completed VM, including a real Docker container, a Chromium screenshot, X11 readiness after a cold boot and pause or resume, exact tool-version checks, and the CUA Driver.
- `MANIFEST.md`: versions, source URLs, and the snapshot identifier after publication.

The Dockerfile and VM bootstrap script may use different installation commands when their runtimes require it. They must install the same named capabilities. A Docker container is not evidence that systemd, nested Docker, or a headed desktop works in the Freestyle VM.

## Public GitHub repository contract

Add optional `repositoryUrl` and `branch` fields to the initial `POST /api/threads` request:

```json
{
  "prompt": "Inspect the project and fix the failing test",
  "clientMessageId": "client-generated-id",
  "repositoryUrl": "https://github.com/owner/repository",
  "branch": "feature/fix-tests"
}
```

The API accepts only an HTTPS URL whose host is `github.com` and whose path contains an owner and repository name. Valid repository names may begin with a dot, including `.github`. It rejects SSH URLs, credentials, query strings, fragments, other hosts, and malformed paths. The API stores the normalized URL on the thread. A follow-up message cannot replace it.

The initial request may include `branch`. The API trims the value, limits it to 255 characters, and accepts only the conservative branch-name subset implemented by `normalizePublicGitHubBranch`. It rejects an empty value, control characters, a leading dash, a leading or trailing slash, a trailing dot or `.lock`, empty path components, `..`, `@{`, and Git ref characters such as `~`, `^`, `:`, `?`, `*`, `[`, and `\\`. The API rejects `branch` when `repositoryUrl` is absent. It stores the validated branch without changing its case or path separators.

The initial request type owns `repositoryUrl` and `branch`. The follow-up request type does not contain either field. The thread response includes both nullable stored values. Idempotent retries compare the normalized URL and branch as well as the prompt, thread, and request kind. A retry with a different URL or branch, or with a URL or branch where the original request had none, returns `IDEMPOTENCY_CONFLICT`.

The runner initializes a workspace in this order:

1. Ensure that `/workspace` exists.
2. If the workspace has a complete checkout whose origin matches the requested URL and has a valid `HEAD`, keep it. The requested branch is an initial checkout target; normal follow-ups preserve branch changes made by Pi.
3. If a runner-owned clone is incomplete, remove only that clone's staging directory and retry from a clean staging directory.
4. If the workspace is empty and the thread has `repositoryUrl`, run a shallow, single-branch clone into a runner-owned staging directory.
5. Pass `--branch` when the thread has a branch. If the thread has no branch, let Git check out the repository's default branch.
6. Verify the origin URL, a checked-out `HEAD`, and the requested branch when one was provided, then copy the staging directory into the pre-created writable `/workspace` directory. A runner-owned promotion marker records the workspace and requested repository identity. After a crash, a valid completed target is reused, valid staging can be promoted again, and only provably runner-owned partial files may be removed. The runner never renames `/workspace` itself.
7. If the workspace is non-empty but is not the requested checkout, fail the run instead of deleting files.
8. Start or resume Pi after repository initialization succeeds.

The clone command must set `GIT_TERMINAL_PROMPT=0`, disable credential helpers, and pass the validated URL and branch as separate, quoted arguments. It must not read credentials from the environment, Git config, SSH config, or a mounted host path. The runner must not fetch submodules in this slice because a submodule may require credentials.

The clone has a bounded timeout and an enforced disk budget. The runner checks free space before cloning, monitors the staging directory while `git clone` runs, terminates the clone when the byte or free-space limit is reached, and removes the failed staging directory. It checks the resulting checkout size after promotion. A missing or private repository produces a run error that identifies anonymous public cloning as the supported mode. An oversized-repository test verifies that the clone is terminated before it fills the VM disk.

When the repository URL is absent, the runner creates `/workspace` and starts Pi there. When the branch is absent, the runner uses the repository's default branch. When the thread continues, the runner does not clone again or change the checked-out branch.

The local Docker provider has no network and cannot clone a public repository. Repository-backed runs therefore require Pi plus Freestyle until a separate local fixture mechanism exists.

## Lifecycle and durability

The thread remains the durable product object. The run is one execution period. The workspace is the Freestyle VM. The browser connection remains disposable.

Freestyle pause and resume preserve the VM's memory and disk. Deleting a VM removes the only copy of uncommitted files and local, unpushed commits in the current implementation. Demo workspaces use one-hour application cleanup after pausing. Owner workspaces skip application deletion and retain the provider plan backstop. Cleanup checks PostgreSQL for accepted queued/running runs and unresolved commands before provider mutation. The runner reports a new filesystem generation when it creates a replacement and does not treat an older Pi checkpoint as describing the replacement filesystem.

External workspace bundles remain deferred. The reliability implementation records filesystem generations and reset events and adds a reset instruction before resuming a checkpoint from an older generation. None of these records restores deleted files. Cleanup is destructive, and the product must not imply that local files survive VM deletion.

If a VM disappears before that persistence work exists, the runner may create a replacement from the golden snapshot, but it must report that the filesystem was rebuilt. It must re-clone the public repository when one is configured. It must add a workspace-reset message to the restored Pi context that states that uncommitted files and local, unpushed commits were lost. It must ask Pi to inspect the rebuilt checkout before continuing. It must not silently resume Pi against a missing checkout. Scheduled deletion and unexpected VM loss both exercise this recovery path.

The operator rebuilds a missing snapshot from `freestyle/ubuntu-sm`, runs `verify.sh` after a cold boot and after pause and resume, captures a new snapshot, updates `FREESTYLE_SNAPSHOT_ID`, and records the snapshot ID and manifest version. A missing-snapshot test covers the provider's recovery or explicit failure path.

## Acceptance criteria

The implementation is complete when:

- The Dockerfile declares the full capability set without credentials.
- `bootstrap.sh` can run twice without damaging the VM or creating duplicate services.
- `verify.sh` checks tool versions, `/workspace`, Docker Compose, Chromium, X11 readiness, noVNC dependencies, and the CUA Driver.
- The API rejects invalid repository URLs and stores valid public GitHub URLs on new threads.
- The API rejects invalid branches, rejects a branch without a repository URL, and stores valid branches on new threads.
- A Freestyle Pi run clones a public repository into `/workspace` before the first Pi tool call.
- A Freestyle Pi run checks out the requested branch before the first Pi tool call.
- A follow-up run reuses the existing checkout.
- A repository-backed Docker run fails with a clear provider error instead of attempting a network operation.
- Existing scripted Docker tests still pass.
- Type checks and focused database, API, and runner tests pass.
- The published snapshot ID and manifest version are documented in `infra/freestyle/MANIFEST.md`.
- Snapshot rebuild instructions cover a deleted or missing snapshot and update `FREESTYLE_SNAPSHOT_ID`.

## Later work

Private repository support needs a GitHub App and a server-side Git broker. Workspace durability needs an external bundle or commit path before cleanup deletes a VM. Computer-use support needs provider methods for screenshots, mouse, keyboard, and authenticated preview access. Those changes are separate from the public clone and snapshot work in this spec.

## Temporary snapshot resources

`rebuild-snapshot.sh` provisions temporary VMs through `apps/runner/src/snapshot-resource-cli.ts`, using the runner's pinned Freestyle SDK. Builders receive a one-hour continuous cap, two-hour lifetime budget, and deletion deadline within twenty-four hours. Validation VMs receive fifteen-minute continuous and thirty-minute lifetime limits with the same absolute deadline.

Creation includes exact project, purpose, build ID, and expiry metadata. Stable slugs allow ambiguous creates to be looked up before retrying. Set `BUILD_ID` to reuse the same identity during manual reconciliation. Existing resource budgets are never raised automatically. The helper requires `FREESTYLE_API_KEY` in the backend environment; it does not pass the key to a VM.

The script verifies the captured snapshot before normal cleanup removes its builder. `KEEP_BUILDER=1` and `KEEP_VALIDATION_VM=1` retain paused resources within their original deadlines. Ordinary completion and failure delete temporary VMs and verify absence. A failed deletion triggers a pause attempt, prints the VM ID, and fails cleanup while preserving the original build exit status. Interrupt and termination signals run the same cleanup path.

Before a build, the helper lists inventory and deletes expired resources only when exact temporary ownership metadata matches. It reports unlabelled VM IDs for manual review. The existing unlabelled `builder-test` is untouched. No live rebuild or provider mutation was performed for this change. The published snapshot manifest retains its historical verification status.

Model authentication is handled by the backend [model broker](backend-contract.md#model-broker). User API keys, OAuth tokens, and the credential encryption key stay on the API server and runner. They are never included in Freestyle snapshots, guest environment variables, or remote commands.
