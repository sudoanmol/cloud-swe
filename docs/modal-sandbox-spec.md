# Modal sandbox and public repository spec

Status: implemented

This document records the sandbox provider and public-clone scope. The [GitHub broker contract](github-broker.md) supersedes its private-Git exclusions and anonymous-only access rules. Image, checkout recovery, storage, timeout, and submodule restrictions still apply.

## Decision

Use a Modal sandbox on the VM runtime as the production workspace. Run Pi on the backend runner. The sandbox provides the filesystem, processes, Docker daemon, preview forwarder, and agent-browser CLI that Pi controls through remote tools. Chrome runs on Kernel.

Modal builds the workspace image from `infra/modal/Dockerfile`, so one recipe defines both the local image and the production workspace. `infra/modal/build_image.py` publishes it as a named image after verification. The VM runtime gives each sandbox its own kernel, which Docker needs. Modal replaced Freestyle; Freestyle workspaces were not migrated.

## Goals

- Start a new Modal sandbox from the published workspace image.
- Include the tools that a coding agent needs for common repositories.
- Include agent-browser and its skill. The CLI reads its remote CDP configuration from `/root/.agent-browser/config.json`; no Chrome or Xvfb is installed.
- Accept one public GitHub repository and optional branch when a user creates a thread, and clone it into `/workspace` before Pi starts.
- Reuse the checkout for follow-up messages in the same thread, including after a pause.
- Stop every sandbox the application starts, both on idle and through a hard provider timeout.
- Keep model, GitHub, Modal, and user credentials out of the image, snapshots, and workspace.
- Rebuild the image from repository-owned files.
- Keep the local Docker provider available for credential-free scripted tests.

## Non-goals

- Preserving processes across a pause. Pi restarts servers and containers it needs.
- Importing an external Docker image or registry.
- Persisting uncommitted workspace changes after a workspace is deleted.
- Exposing a public, unauthenticated Chrome DevTools endpoint.
- Desktop and visual computer-use tooling.

## Current implementation

- `apps/runner/src/modal.ts` creates, restores, pauses, and deletes Modal sandboxes and runs guest commands.
- `RUNNER_EXECUTION_MODE=pi` requires `RUNNER_SANDBOX_PROVIDER=modal`.
- `RUNNER_EXECUTION_MODE=scripted` uses a network-disabled local Docker container or Modal.
- `MODAL_IMAGE_NAME` selects the published image, and `MODAL_APP_NAME` the app that owns every workspace sandbox.
- Pi tools expose remote shell, read, write, and literal edit operations.

## Image contents

`infra/modal/MANIFEST.md` records the installed capabilities, verified versions, and the published image ID. The image runs `supervisord` as the sandbox entrypoint. It starts Docker and the preview forwarder on port 7999. The runner writes a mode-0600 agent-browser config with a scoped, expiring gateway URL through the execution coordinator. Guest commands run as root. The image contains no browser profile, login state, API key, SSH key, Git credential, or Modal credential.

## Image artifacts

Keep these files under `infra/modal/`:

- `Dockerfile`: the image recipe.
- `capabilities.list` and `install-toolchain.sh`: the package contract and toolchain installer.
- `supervisord.conf`: the services and their stale-lock cleanup after a restore.
- `verify.sh`: capability checks, including a real Docker container, the agent-browser CLI remote/config options and a loopback preview request, the installed agent-browser skill, and exact tool versions.
- `build_image.py`: builds the image, runs `verify.sh` on a cold boot and after an exit-snapshot restore, and publishes only when both pass.
- `MANIFEST.md`: versions, recipe hashes, and the published image ID.

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
4. If the workspace is empty and the thread has `repositoryUrl`, run a single-branch clone with that branch's full history into a runner-owned staging directory.
5. Pass `--branch` when the thread has a branch. If the thread has no branch, let Git check out the repository's default branch.
6. Verify the origin URL, a checked-out `HEAD`, and the requested branch when one was provided, then copy the staging directory into the pre-created writable `/workspace` directory. A runner-owned promotion marker records the workspace and requested repository identity. After a crash, a valid completed target is reused, valid staging can be promoted again, and only provably runner-owned partial files may be removed. The runner never renames `/workspace` itself.
7. If the workspace is non-empty but is not the requested checkout, fail the run instead of deleting files.
8. Start or resume Pi after repository initialization succeeds.

The clone command must set `GIT_TERMINAL_PROMPT=0`, disable credential helpers, and pass the validated URL and branch as separate, quoted arguments. It must not read credentials from the environment, Git config, SSH config, or a mounted host path. The runner must not fetch submodules in this slice because a submodule may require credentials.

The clone has a bounded timeout and an enforced disk budget. The runner checks free space before cloning, monitors the staging directory while `git clone` runs, terminates the clone when the byte or free-space limit is reached, and removes the failed staging directory. It checks the resulting checkout size after promotion. A missing or private repository produces a run error that identifies anonymous public cloning as the supported mode. An oversized-repository test verifies that the clone is terminated before it fills the VM disk.

When the repository URL is absent, the runner creates `/workspace` and starts Pi there. When the branch is absent, the runner uses the repository's default branch. When the thread continues, the runner does not clone again or change the checked-out branch.

The local Docker provider has no network and cannot clone a public repository. Repository-backed runs therefore require Pi plus Modal until a separate local fixture mechanism exists.

## Lifecycle and durability

The thread remains the durable product object. The run is one execution period. The workspace is a chain of Modal sandboxes that share one filesystem. The browser connection remains disposable.

Every sandbox has a hard Modal timeout, `MODAL_MAX_RUN_SECONDS`. Modal stops the sandbox at that deadline even when the runner is down or a pause fails. The provider sets no Modal idle timeout; the application's idle timer pauses the workspace. Exit snapshots capture the filesystem whenever a sandbox stops, including at the hard timeout.

Pause terminates the sandbox and waits for its exit snapshot. The next run restores that snapshot into a new sandbox under the same name. The provider reports `restored`, the generation stays the same, and the checkout is reused. Guest processes and containers do not survive; supervisord starts the services again. Kernel owns browser sessions independently and saves the thread profile when its browser ends. The relay rejects capabilities while the workspace is paused. A running sandbox with too little lifetime left for a run is paused and restored first.

Deletion terminates the sandbox and deletes its final exit snapshot. When a snapshot is gone, the runner creates a sandbox from the published image and reports that the filesystem was rebuilt. It re-clones the repository, adds the workspace-reset message to the restored Pi context, and asks Pi to inspect the rebuilt checkout. It never silently resumes Pi against a missing checkout. The application never deletes a paused workspace. Modal keeps each exit snapshot for 30 days after creation, and that retention cannot be extended; an older snapshot is reported as gone and the workspace is rebuilt.

Cleanup checks PostgreSQL for accepted queued or running runs and unresolved commands before provider mutation. Conversation checkpoints do not back up files.

## Acceptance criteria

- `build_image.py` publishes only after `verify.sh` passes on a cold boot and after an exit-snapshot restore.
- A Modal Pi run clones a public repository into `/workspace` and checks out the requested branch before the first Pi tool call.
- A follow-up after an idle pause restores the files into a new sandbox with the same generation.
- The application's idle pause leaves no running sandbox for the workspace, as observed through the Modal API, and cleanup deletion does the same.
- A deleted workspace's next run creates a fresh sandbox and records a workspace reset.
- A repository-backed Docker run fails with a clear provider error instead of attempting a network operation.
- `bun run test:backend:paid` passes; it covers the live provider lifecycle, the end-to-end idle lifecycle, and a Pi run.

## Later work

Workspace durability beyond Modal's snapshot retention needs an external bundle or commit path. A periodic sweep of managed sandboxes without a matching active workspace would stop orphans before their hard timeout.

Model authentication is handled by the backend [model broker](backend-contract.md#model-broker). User API keys, OAuth tokens, and the credential encryption key stay on the API server and runner. They are never included in Modal images, snapshots, guest environment variables, or remote commands.
