import {
  normalizePublicGitHubBranch,
  normalizePublicGitHubUrl,
} from "@cloud-swe/db/repository-url";
import { createHash } from "node:crypto";
import type { SandboxProvider, WorkspaceRef } from "./sandbox.js";

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

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Repository limits must be positive integers");
  return String(value);
}

function commandFailure(result: {
  stdout: string;
  stderr: string;
  statusCode: number | null;
}): never {
  const output = `${result.stderr}\n${result.stdout}`.trim().slice(0, 2_000);
  const detail = output || `remote command exited with ${result.statusCode ?? "no status"}`;
  const nonRetryable =
    result.statusCode === 65 || result.statusCode === 75 || result.statusCode === 124;
  throw new RepositoryInitializationError(
    `Anonymous public GitHub checkout failed. Private repositories are not supported. ${detail}`,
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
    workspaceBackupPath?: string;
  } = {},
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceKey))
    throw new Error("Repository workspace key must be a safe path component");
  const workspacePath = paths.workspacePath ?? workspaceRoot;
  const stagingRoot = paths.stagingRoot ?? repositoryStagingRoot;
  const workspaceBackupPath =
    paths.workspaceBackupPath ?? `${stagingRoot}/${workspaceKey}.workspace-backup`;
  const branchArgument = repositoryBranch ? `--branch ${quoteShell(repositoryBranch)}` : "";
  return `
set -eu
workspace=${quoteShell(workspacePath)}
requested_url=${quoteShell(repositoryUrl)}
requested_branch=${quoteShell(repositoryBranch ?? "")}
staging_parent=${quoteShell(stagingRoot)}
staging="$staging_parent/${workspaceKey}.staging"
log="$staging_parent/${workspaceKey}.log"
workspace_backup=${quoteShell(workspaceBackupPath)}
promotion_marker="$staging_parent/${workspaceKey}.promotion"
timeout_seconds=${shellNumber(Math.max(1, Math.ceil(cloneTimeoutMs / 1_000)))}
max_bytes=${shellNumber(maxBytes)}
min_free_bytes=${shellNumber(minFreeBytes)}
clone_pid=""
clone_group=""
promotion_started=0
promotion_complete=0

available_bytes() {
  df -Pk "$1" | awk 'NR == 2 { print $4 * 1024 }'
}

directory_bytes() {
  size="$(du -sb "$1" 2>/dev/null | awk '{ print $1 }' || true)"
  if [ -n "$size" ]; then
    printf '%s\n' "$size"
  else
    du -sk "$1" | awk '{ print $1 * 1024 }'
  fi
}

filesystem_device() {
  if stat -c '%d' "$1" 2>/dev/null; then
    return 0
  fi
  stat -f '%d' "$1"
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
  for attempt in $(seq 1 20); do
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

cleanup() {
  terminate_clone
  if [ "$promotion_complete" = "1" ]; then
    rm -f -- "$promotion_marker"
  fi
  rm -rf -- "$staging" "$log"
}
trap cleanup EXIT INT TERM

install -d -m 0700 -- "$staging_parent"
if [ -e "$promotion_marker" ]; then
  echo "An interrupted repository promotion needs manual workspace inspection" >&2
  exit 65
fi
if [ -e "$workspace_backup" ]; then
  if [ ! -e "$workspace" ]; then
    mv -- "$workspace_backup" "$workspace"
  elif git -C "$workspace" rev-parse --verify HEAD >/dev/null 2>&1; then
    recovery_origin="$(git -C "$workspace" config --get remote.origin.url || true)"
    recovery_origin_without_suffix="\${recovery_origin%.git}"
    recovery_requested_without_suffix="\${requested_url%.git}"
    recovery_branch="$(git -C "$workspace" symbolic-ref --quiet --short HEAD || true)"
    if [ "$recovery_origin" = "$requested_url" ] ||
      [ "$recovery_origin_without_suffix" = "$recovery_requested_without_suffix" ]; then
      if [ -z "$requested_branch" ] || [ "$recovery_branch" = "$requested_branch" ]; then
        rmdir -- "$workspace_backup"
      else
        echo "Interrupted repository promotion left a mismatched branch" >&2
        exit 65
      fi
    else
      echo "Interrupted repository promotion left a mismatched origin" >&2
      exit 65
    fi
  else
    echo "Interrupted repository promotion left an incomplete checkout" >&2
    exit 65
  fi
fi
mkdir -p -- "$workspace"

if git -C "$workspace" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
  git -C "$workspace" rev-parse --verify HEAD >/dev/null 2>&1; then
  origin="$(git -C "$workspace" config --get remote.origin.url || true)"
  checked_out_branch="$(git -C "$workspace" symbolic-ref --quiet --short HEAD || true)"
  origin_without_suffix="\${origin%.git}"
  requested_without_suffix="\${requested_url%.git}"
  if [ "$origin" != "$requested_url" ] && [ "$origin_without_suffix" != "$requested_without_suffix" ]; then
    echo "Workspace origin does not match the requested public GitHub repository" >&2
    exit 65
  fi
  if [ -n "$requested_branch" ] && [ "$checked_out_branch" != "$requested_branch" ]; then
    echo "Workspace branch does not match the requested branch" >&2
    exit 65
  fi
  printf 'reused\n'
  exit 0
fi

workspace_entry="$(find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)"
if [ -n "$workspace_entry" ]; then
  echo "Workspace is non-empty but is not the requested checkout" >&2
  exit 65
fi

rm -rf -- "$staging" "$log"
available="$(available_bytes "$workspace")"
if [ -z "$available" ] || [ "$available" -lt "$min_free_bytes" ]; then
  echo "Workspace does not have enough free disk space to clone the repository" >&2
  exit 75
fi

export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/false
export SSH_ASKPASS=/bin/false
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null

if command -v setsid >/dev/null 2>&1; then
  setsid --wait git -c credential.helper= -c core.askPass= clone --depth 1 --no-tags --single-branch ${branchArgument} -- "$requested_url" "$staging" >"$log" 2>&1 &
  clone_pid=$!
  clone_group="$clone_pid"
else
  git -c credential.helper= -c core.askPass= clone --depth 1 --no-tags --single-branch ${branchArgument} -- "$requested_url" "$staging" >"$log" 2>&1 &
  clone_pid=$!
fi
deadline=$(($(date +%s) + timeout_seconds))
while clone_alive; do
  now="$(date +%s)"
  size="$(directory_bytes "$staging")"
  available="$(available_bytes "$workspace")"
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
  echo "git clone failed:" >&2
  cat "$log" >&2 || true
  exit 65
fi
clone_pid=""
clone_group=""

origin="$(git -C "$staging" config --get remote.origin.url || true)"
origin_without_suffix="\${origin%.git}"
requested_without_suffix="\${requested_url%.git}"
if [ "$origin" != "$requested_url" ] && [ "$origin_without_suffix" != "$requested_without_suffix" ]; then
  echo "Cloned origin does not match the requested public GitHub repository" >&2
  exit 65
fi
git -C "$staging" rev-parse --verify HEAD >/dev/null 2>&1 || {
  echo "The cloned repository has no checked-out HEAD" >&2
  exit 65
}
if [ -n "$requested_branch" ]; then
  checked_out_branch="$(git -C "$staging" symbolic-ref --quiet --short HEAD || true)"
  if [ "$checked_out_branch" != "$requested_branch" ]; then
    echo "Git did not check out the requested branch" >&2
    exit 65
  fi
fi
size="$(directory_bytes "$staging")"
if [ "$size" -gt "$max_bytes" ]; then
  echo "Repository clone exceeded its disk budget" >&2
  exit 75
fi
workspace_device="$(filesystem_device "$workspace")"
staging_device="$(filesystem_device "$staging_parent")"
if [ -z "$workspace_device" ] || [ "$workspace_device" != "$staging_device" ]; then
  echo "Repository staging directory is not on the workspace filesystem" >&2
  exit 75
fi
if [ -e "$workspace_backup" ]; then
  echo "Repository promotion is already in progress" >&2
  exit 65
fi
workspace_entry="$(find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)"
if [ -n "$workspace_entry" ]; then
  echo "Workspace changed while the repository was cloning" >&2
  exit 65
fi
available="$(available_bytes "$workspace")"
required_free=$((size + min_free_bytes))
if [ -z "$available" ] || [ "$available" -lt "$required_free" ]; then
  echo "Workspace does not have enough free disk space to promote the repository" >&2
  exit 75
fi
promotion_started=1
printf '%s\n' "$workspace" >"$promotion_marker"
cp -a -- "$staging"/. "$workspace"/
if ! git -C "$workspace" rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "Repository promotion did not produce a checked-out HEAD" >&2
  exit 65
fi
git -C "$workspace" config cloud-swe.checkout-complete true
promotion_complete=1
rm -rf -- "$staging" "$promotion_marker"
printf 'cloned\n'
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
    if (result.statusCode !== 0) commandFailure(result);
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
      timeoutMs: Math.min(
        Math.max(options.cloneTimeoutMs + repositoryCleanupGraceMs, defaultCommandTimeoutMs),
        300_000,
      ),
    },
    signal,
  );
  if (result.statusCode !== 0) commandFailure(result);
  const outcome = result.stdout.trim();
  if (outcome === "reused" || outcome === "cloned") return outcome;
  throw new RepositoryInitializationError(
    "Repository initialization returned an invalid result",
    false,
  );
}
