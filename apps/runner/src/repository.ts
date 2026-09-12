import { quoteShell } from "./text.js";
import {
  normalizePublicGitHubBranch,
  normalizePublicGitHubUrl,
} from "@cloud-swe/db/repository-url";
import { createHash } from "node:crypto";
import type { CommandResult, SandboxProvider, WorkspaceRef } from "./sandbox.js";

const workspaceRoot = "/workspace";

const repositoryStagingRoot = "/var/lib/cloud-swe/repository";

const defaultCommandTimeoutMs = 20_000;

const repositoryCleanupGraceMs = 30_000;

export class RepositoryInitializationError extends Error {
  readonly nonRetryable: boolean;

  constructor(message: string, nonRetryable = true) {
    super(message);
    this.name = "RepositoryInitializationError";
    this.nonRetryable = nonRetryable;
  }
}

export type RepositoryInitializationOptions = {
  sandbox: SandboxProvider;
  workspace: WorkspaceRef;
  repositoryUrl: string | null;
  repositoryBranch: string | null;
  cloneTimeoutMs: number;
  maxBytes: number;
  minFreeBytes: number;
  signal: AbortSignal;
};

function shellNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Repository limits must be positive integers");

  return String(value);
}

function commandFailure(result: CommandResult): never {
  const output = `${result.stderr}\n${result.stdout}`.trim().slice(0, 2_000);
  const processResult = result.kind === "completed" || result.kind === "failed";
  const status = processResult ? result.statusCode : null;
  const transportDetail = "error" in result && result.error ? `: ${result.error}` : "";

  const kindDetail = processResult
    ? `remote command exited with ${status}`
    : `remote command ${result.kind}${transportDetail}`;

  const detail = output ? `${kindDetail}: ${output}` : kindDetail;
  const truncation = result.outputTruncated ? " (diagnostics truncated)" : "";
  const nonRetryable = status === 65 || status === 75 || status === 124;
  throw new RepositoryInitializationError(
    `Anonymous public GitHub checkout failed. Private repositories are not supported. ${detail}${truncation}`,
    nonRetryable,
  );
}

export function buildRepositoryCheckoutCommand(
  workspaceKey: string,
  repositoryUrl: string,
  repositoryBranch: string | null,
  cloneTimeoutMs: number,
  maxBytes: number,
  minFreeBytes: number,
  paths: {
    workspacePath?: string;
    stagingRoot?: string;
  } = {},
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceKey))
    throw new Error("Repository workspace key must be a safe path component");
  const workspacePath = paths.workspacePath ?? workspaceRoot;
  const stagingRoot = paths.stagingRoot ?? repositoryStagingRoot;

  return `
set -eu
umask 077
workspace=${quoteShell(workspacePath)}
workspace_key=${quoteShell(workspaceKey)}
requested_url=${quoteShell(repositoryUrl)}
requested_branch=${quoteShell(repositoryBranch ?? "")}
staging_parent=${quoteShell(stagingRoot)}
staging="$staging_parent/${workspaceKey}.staging"
log="$staging_parent/${workspaceKey}.log"
promotion_marker="$staging_parent/${workspaceKey}.promotion"
promotion_marker_tmp="$promotion_marker.tmp"
timeout_seconds=${shellNumber(Math.max(1, Math.ceil(cloneTimeoutMs / 1_000)))}
max_bytes=${shellNumber(maxBytes)}
min_free_bytes=${shellNumber(minFreeBytes)}
clone_pid=""
clone_group=""
staging_ready=0
marker_verified=0
requested_url_without_suffix="\${requested_url%.git}"
expected_marker="$(printf 'version=1\\nworkspace_key=%s\\nworkspace_path=%s\\nrepository_url=%s\\nrepository_branch=%s' "$workspace_key" "$workspace" "$requested_url" "$requested_branch")"

available_bytes() {
  df -Pk "$1" | awk 'NR == 2 { print $4 * 1024 }'
}

directory_bytes() {
  du -sb -- "$1" 2>/dev/null | awk 'NR == 1 { print $1 }'
}

filesystem_device() {
  stat -c '%d' -- "$1"
}

clone_alive() {
  if [ -n "$clone_pid" ] && kill -0 "$clone_pid" 2>/dev/null; then
    return 0
  fi
  if [ -n "$clone_group" ] && /bin/kill -0 -- "-$clone_group" 2>/dev/null; then
    return 0
  fi
  return 1
}

terminate_clone() {
  if [ -z "$clone_pid" ]; then
    return 0
  fi
  if [ -n "$clone_group" ]; then
    /bin/kill -TERM -- "-$clone_group" 2>/dev/null || true
  fi
  kill -TERM "$clone_pid" 2>/dev/null || true
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ! clone_alive; then
      break
    fi
    sleep 0.1
  done
  if clone_alive; then
    if [ -n "$clone_group" ]; then
      /bin/kill -KILL -- "-$clone_group" 2>/dev/null || true
    fi
    kill -KILL "$clone_pid" 2>/dev/null || true
  fi
  wait "$clone_pid" 2>/dev/null || true
  clone_pid=""
  clone_group=""
}

marker_exists() {
  [ -e "$promotion_marker" ] || [ -L "$promotion_marker" ]
}

marker_matches() {
  [ -f "$promotion_marker" ] || return 1
  marker_contents="$(cat -- "$promotion_marker" 2>/dev/null || true)"
  [ "$marker_contents" = "$expected_marker" ]
}

write_promotion_marker() {
  printf '%s\\n' "$expected_marker" >"$promotion_marker_tmp"
  mv -f -- "$promotion_marker_tmp" "$promotion_marker"
}

read_origin() {
  git -C "$1" config --get remote.origin.url 2>/dev/null ||
    git config --file "$1/.git/config" --get remote.origin.url 2>/dev/null ||
    true
}

origin_is_readable() {
  candidate_origin="$(read_origin "$1")"
  [ -n "$candidate_origin" ]
}

origin_matches_requested() {
  candidate_origin="$(read_origin "$1")"
  candidate_origin_without_suffix="\${candidate_origin%.git}"
  [ "$candidate_origin" = "$requested_url" ] ||
    [ "$candidate_origin_without_suffix" = "$requested_url_without_suffix" ]
}

has_valid_head() {
  [ -d "$1" ] &&
    git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
    git -C "$1" rev-parse --verify HEAD >/dev/null 2>&1
}

requested_branch_matches() {
  [ -z "$requested_branch" ] ||
    [ "$(git -C "$1" symbolic-ref --quiet --short HEAD || true)" = "$requested_branch" ]
}

matching_checkout() {
  has_valid_head "$1" && origin_matches_requested "$1"
}

promotable_checkout() {
  matching_checkout "$1" && requested_branch_matches "$1"
}

workspace_entry=""
workspace_is_empty() {
  workspace_entry="$(find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)"
  [ -z "$workspace_entry" ]
}

clear_workspace() {
  find "$workspace" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
}

cleanup() {
  terminate_clone
  if [ "$marker_verified" = "1" ]; then
    rm -f -- "$promotion_marker_tmp" || true
  elif ! marker_exists; then
    rm -rf -- "$staging" "$log" "$promotion_marker_tmp" || true
  fi
}
trap cleanup EXIT INT TERM

install -d -m 0700 -- "$staging_parent"
if marker_exists; then
  if ! marker_matches; then
    echo "Repository promotion marker does not belong to this workspace or repository" >&2
    exit 65
  fi
  marker_verified=1
fi
if [ -L "$workspace" ]; then
  echo "Repository workspace is a symbolic link; refusing to inspect or delete it" >&2
  exit 65
fi
mkdir -p -- "$workspace"

if marker_exists; then
  if promotable_checkout "$workspace"; then
    rm -rf -- "$staging" "$log"
    rm -f -- "$promotion_marker"
    marker_verified=0
    printf 'reused\\n'
    exit 0
  fi

  if [ -e "$staging" ]; then
    if has_valid_head "$staging"; then
      if ! origin_matches_requested "$staging"; then
        echo "Interrupted repository staging checkout has a mismatched origin" >&2
        exit 65
      fi
      if ! requested_branch_matches "$staging"; then
        echo "Interrupted repository staging checkout has a mismatched branch" >&2
        exit 65
      fi
      staging_ready=1
    else
      rm -rf -- "$staging" "$log"
    fi
  fi

  if origin_is_readable "$workspace" && ! origin_matches_requested "$workspace"; then
    echo "Interrupted repository promotion left a mismatched origin" >&2
    exit 65
  fi
  if has_valid_head "$workspace"; then
    echo "Interrupted repository promotion left a mismatched branch" >&2
    exit 65
  fi
  if ! workspace_is_empty; then
    clear_workspace
  fi
else
  if matching_checkout "$workspace"; then
    rm -rf -- "$staging" "$log"
    printf 'reused\\n'
    exit 0
  fi
  if has_valid_head "$workspace"; then
    echo "Workspace origin does not match the requested public GitHub repository" >&2
    exit 65
  fi
  if ! workspace_is_empty; then
    echo "Workspace is non-empty but is not the requested checkout" >&2
    exit 65
  fi
  rm -rf -- "$staging" "$log"
fi

if [ "$staging_ready" -eq 0 ]; then
  available="$(available_bytes "$workspace" || true)"
  if [ -z "$available" ] || [ "$available" -lt "$min_free_bytes" ]; then
    echo "Workspace does not have enough free disk space to clone the repository" >&2
    exit 75
  fi

  export GIT_TERMINAL_PROMPT=0
  export GIT_ASKPASS=/bin/false
  export SSH_ASKPASS=/bin/false
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_GLOBAL=/dev/null

  if [ -n "$requested_branch" ]; then
    setsid --wait git -c credential.helper= -c core.askPass= clone --depth 1 --no-tags --single-branch --no-recurse-submodules --branch "$requested_branch" -- "$requested_url" "$staging" >"$log" 2>&1 &
  else
    setsid --wait git -c credential.helper= -c core.askPass= clone --depth 1 --no-tags --single-branch --no-recurse-submodules -- "$requested_url" "$staging" >"$log" 2>&1 &
  fi
  clone_pid="$!"
  clone_group="$clone_pid"
  deadline_now="$(date +%s)"
  deadline="$((deadline_now + timeout_seconds))"
  while clone_alive; do
    now="$(date +%s)"
    size="$(directory_bytes "$staging" || true)"
    available="$(available_bytes "$workspace" || true)"
    if [ "$now" -ge "$deadline" ]; then
      echo "Repository clone exceeded its time limit" >&2
      exit 124
    fi
    if [ -n "$size" ] && [ "$size" -gt "$max_bytes" ]; then
      echo "Repository clone exceeded its disk budget" >&2
      exit 75
    fi
    if [ -z "$available" ] || [ "$available" -lt "$min_free_bytes" ]; then
      echo "Repository clone reached the free disk limit" >&2
      exit 75
    fi
    sleep 1
  done
  if ! wait "$clone_pid"; then
    clone_pid=""
    clone_group=""
    echo "git clone failed:" >&2
    cat -- "$log" >&2 || true
    exit 65
  fi
  clone_pid=""
  clone_group=""
fi

if ! has_valid_head "$staging"; then
  echo "The cloned repository has no checked-out HEAD" >&2
  exit 65
fi
if ! origin_matches_requested "$staging"; then
  echo "Cloned origin does not match the requested public GitHub repository" >&2
  exit 65
fi
if ! requested_branch_matches "$staging"; then
  echo "Git did not check out the requested branch" >&2
  exit 65
fi
size="$(directory_bytes "$staging" || true)"
if [ -z "$size" ] || [ "$size" -gt "$max_bytes" ]; then
  echo "Repository clone exceeded its disk budget" >&2
  exit 75
fi
workspace_device="$(filesystem_device "$workspace" || true)"
staging_device="$(filesystem_device "$staging_parent" || true)"
if [ -z "$workspace_device" ] || [ "$workspace_device" != "$staging_device" ]; then
  echo "Repository staging directory is not on the workspace filesystem" >&2
  exit 75
fi
if ! workspace_is_empty; then
  echo "Workspace changed while the repository was cloning" >&2
  exit 65
fi
available="$(available_bytes "$workspace" || true)"
required_free="$((size + min_free_bytes))"
if [ -z "$available" ] || [ "$available" -lt "$required_free" ]; then
  echo "Workspace does not have enough free disk space to promote the repository" >&2
  exit 75
fi
write_promotion_marker
marker_verified=1
cp -a -- "$staging/." "$workspace/"
if ! promotable_checkout "$workspace"; then
  if has_valid_head "$workspace"; then
    echo "Promoted repository does not match the requested origin or branch" >&2
  else
    echo "Repository promotion did not produce a checked-out HEAD" >&2
  fi
  exit 65
fi
rm -rf -- "$staging" "$log"
rm -f -- "$promotion_marker"
marker_verified=0
printf 'cloned\\n'
`;
}

export async function initializeRepository(
  options: RepositoryInitializationOptions,
): Promise<"empty" | "reused" | "cloned"> {
  const { sandbox, workspace, repositoryUrl, repositoryBranch, signal } = options;

  if (!repositoryUrl) {
    const result = await sandbox.exec(
      workspace,
      {
        command: `install -d -m 0755 -- ${quoteShell(workspaceRoot)}`,
        timeoutMs: defaultCommandTimeoutMs,
      },
      signal,
    );

    if (result.kind !== "completed" || result.statusCode !== 0) commandFailure(result);

    return "empty";
  }

  if (workspace.provider !== "freestyle")
    throw new RepositoryInitializationError(
      "Repository-backed workspaces require the Freestyle provider because the local Docker provider has no network",
    );
  const normalizedUrl = normalizePublicGitHubUrl(repositoryUrl);
  const normalizedBranch = repositoryBranch ? normalizePublicGitHubBranch(repositoryBranch) : null;

  if (!normalizedUrl)
    throw new RepositoryInitializationError("Stored repository URL is not a public GitHub URL");

  if (repositoryBranch && !normalizedBranch)
    throw new RepositoryInitializationError(
      "Stored repository branch is not a valid GitHub branch",
    );

  const result = await sandbox.exec(
    workspace,
    {
      command: buildRepositoryCheckoutCommand(
        createHash("sha256").update(workspace.name).digest("hex"),
        normalizedUrl,
        normalizedBranch,
        options.cloneTimeoutMs,
        options.maxBytes,
        options.minFreeBytes,
      ),
      timeoutMs: Math.max(
        options.cloneTimeoutMs + repositoryCleanupGraceMs,
        defaultCommandTimeoutMs,
      ),
    },
    signal,
  );

  if (result.kind !== "completed" || result.statusCode !== 0) commandFailure(result);
  const outcome = result.stdout.trim();

  if (outcome === "reused" || outcome === "cloned") return outcome;
  throw new RepositoryInitializationError(
    "Repository initialization returned an invalid result",
    false,
  );
}
