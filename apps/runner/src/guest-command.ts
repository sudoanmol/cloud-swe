import { randomUUID } from "node:crypto";
import type { CommandOperationState } from "@cloud-swe/db/thread-contracts";
import {
  isProcessResult,
  type CommandRequest,
  type CommandResult,
  type WorkspaceRef,
} from "./sandbox.js";

// This journal intentionally lives outside /workspace. A repository checkout
// must remain empty until repository initialization has completed, while the
// journal must survive a runner worker crash inside the guest.
const commandRoot = "/tmp/cloud-swe-commands";
const resultPrefix = "__CLOUD_SWE_RESULT__";
const stdoutBegin = "__CLOUD_SWE_STDOUT_BEGIN__";
const stdoutEnd = "__CLOUD_SWE_STDOUT_END__";
const stderrBegin = "__CLOUD_SWE_STDERR_BEGIN__";
const stderrEnd = "__CLOUD_SWE_STDERR_END__";

export type GuestCommandOwner = {
  commandId: string;
  workspace: WorkspaceRef;
  runId: string;
  attemptId: string;
};

export type GuestCommandObservation = {
  state: CommandOperationState;
  statusCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  /** Transport failures and malformed guest responses are never guest failures. */
  reason?: string;
};

export type GuestCommandRequest = {
  owner: GuestCommandOwner;
  request: CommandRequest;
  outputMaxBytes: number;
};

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${label} contains unsafe path characters`);
  return value;
}

function rootPath(owner: GuestCommandOwner): string {
  return `${commandRoot}/${safeSegment(owner.workspace.id, "workspace id")}`;
}

function statePath(owner: GuestCommandOwner): string {
  return `${rootPath(owner)}/${safeSegment(owner.commandId, "command id")}`;
}

function marker(owner: GuestCommandOwner): string {
  return `${resultPrefix}${owner.commandId}`;
}

function metadataLines(owner: GuestCommandOwner): string {
  return [
    `commandId=${owner.commandId}`,
    `workspaceId=${owner.workspace.id}`,
    `threadId=${owner.workspace.threadId}`,
    `workspaceName=${owner.workspace.name}`,
    `provider=${owner.workspace.provider}`,
    `generation=${owner.workspace.generation}`,
    `runId=${owner.runId}`,
    `attemptId=${owner.attemptId}`,
    "",
  ].join("\\n");
}

function shellCommand(
  owner: GuestCommandOwner,
  request: CommandRequest,
  outputMaxBytes: number,
): string {
  const root = rootPath(owner);
  const directory = statePath(owner);
  const commandEncoded = encode(request.command);
  const stdinEncoded = encode(request.stdin ?? "");
  const timeoutSeconds = Math.max(1, Math.ceil(Math.max(1, request.timeoutMs ?? 30_000) / 1_000));
  const maxBytes = Math.max(2, Math.floor(outputMaxBytes));
  const resultMarker = marker(owner);
  const expectedMetadata = metadataLines(owner);
  return `
set -eu
root=${quote(root)}
dir=${quote(directory)}
lock=$root/.lock
validate_dir() {
  target=$1
  if [ -L "$target" ]; then exit 70; fi
  if [ -e "$target" ] && [ ! -d "$target" ]; then exit 70; fi
}
validate_dir ${quote(commandRoot)}
mkdir -p -- ${quote(commandRoot)}
chmod 700 -- ${quote(commandRoot)}
validate_dir "$root"
mkdir -p -- "$root"
chmod 700 -- "$root"
validate_dir "$dir"
mkdir -p -- "$dir"
chmod 700 -- "$dir"
write_atomic() { tmp="$1.tmp.$$"; printf '%s' "$2" >"$tmp"; mv -f -- "$tmp" "$1"; }
lock_is_free() {
  exec 8>"$lock"
  if flock -n 8; then flock -u 8; exec 8>&-; return 0; fi
  exec 8>&-
  return 1
}
metadata_matches() {
  [ -f "$dir/metadata" ] || return 1
  expected=${quote(expectedMetadata)}
  actual=$(cat -- "$dir/metadata")
  [ "$actual" = "$expected" ]
}
emit_result() {
  state=$(cat -- "$dir/state" 2>/dev/null || printf 'unknown')
  code=$(cat -- "$dir/exit-code" 2>/dev/null || printf '')
  truncated=$(cat -- "$dir/output-truncated" 2>/dev/null || printf '0')
  timed_out=$(cat -- "$dir/timed-out" 2>/dev/null || printf '0')
  if [ "$state" = completed ] || [ "$state" = failed ]; then
    if ! lock_is_free; then
      printf '%s\\trunning\\t\\t%s\\t0\\n' ${quote(resultMarker)}
      return
    fi
  fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' ${quote(resultMarker)} "$state" "$code" "$truncated" "$timed_out"
}
capture_stream() {
  fifo=$1
  output=$2
  limit=$3
  flag=$4
  # Never touch the workspace lock: the reader must not pin it while the
  # command runs, or reconciliation would report a settled command as running.
  exec 9>&-
  # Open the fifo once for the whole group. Reopening it after head exits
  # would block forever when a fast command already closed the write end.
  { head -c $((limit + 1)) >"$output.capture"; cat >/dev/null; } <"$fifo"
  bytes=$(wc -c <"$output.capture")
  if [ "$bytes" -gt "$limit" ]; then
    head -c "$limit" "$output.capture" >"$output.trim"
    mv -f -- "$output.trim" "$output"
    printf '1' >"$flag"
  else
    mv -f -- "$output.capture" "$output"
  fi
}
if [ -f "$dir/state" ]; then
  if ! metadata_matches; then
    printf '%s\\tunknown\\t\\t0\\t0\\n' ${quote(resultMarker)}
    exit 0
  fi
  existing=$(cat -- "$dir/state")
  if [ "$existing" = completed ] || [ "$existing" = failed ] || [ "$existing" = pending ] || [ "$existing" = running ]; then
    emit_result
    exit 0
  fi
fi
umask 077
write_atomic "$dir/metadata" ${quote(expectedMetadata)}
printf '%s' ${quote(commandEncoded)} | base64 -d >"$dir/command.sh"
printf '%s' ${quote(stdinEncoded)} | base64 -d >"$dir/stdin"
: >"$dir/stdout"
: >"$dir/stderr"
write_atomic "$dir/output-truncated" 0
write_atomic "$dir/timed-out" 0
write_atomic "$dir/state" pending
exec 9>"$lock"
flock -x 9
existing=$(cat -- "$dir/state")
if [ "$existing" = completed ] || [ "$existing" = failed ] || [ "$existing" = running ]; then
  emit_result
  exit 0
fi
write_atomic "$dir/state" running
stdout_fifo="$dir/stdout.pipe"
stderr_fifo="$dir/stderr.pipe"
rm -f -- "$stdout_fifo" "$stderr_fifo"
mkfifo -- "$stdout_fifo" "$stderr_fifo"
stdout_limit=$(( ${maxBytes} / 2 ))
stderr_limit=$(( ${maxBytes} - stdout_limit ))
[ "$stdout_limit" -lt 1 ] && stdout_limit=1
[ "$stderr_limit" -lt 1 ] && stderr_limit=1
capture_stream "$stdout_fifo" "$dir/stdout" "$stdout_limit" "$dir/output-truncated" &
stdout_reader=$!
capture_stream "$stderr_fifo" "$dir/stderr" "$stderr_limit" "$dir/output-truncated" &
stderr_reader=$!
started=$(date +%s)
deadline=$((started + ${timeoutSeconds}))
set +e
timeout --kill-after=5s ${quote(`${timeoutSeconds}s`)} sh "$dir/command.sh" <"$dir/stdin" >"$stdout_fifo" 2>"$stderr_fifo"
code=$?
set -e
wait "$stdout_reader" || true
wait "$stderr_reader" || true
rm -f -- "$stdout_fifo" "$stderr_fifo"
finished=$(date +%s)
timed_out=0
if [ "$code" -eq 124 ] && [ "$finished" -ge "$deadline" ]; then timed_out=1; fi
write_atomic "$dir/timed-out" "$timed_out"
if [ "$timed_out" -eq 1 ]; then
  write_atomic "$dir/exit-code" 124
  write_atomic "$dir/state" failed
else
  write_atomic "$dir/exit-code" "$code"
  if [ "$code" -eq 0 ]; then write_atomic "$dir/state" completed; else write_atomic "$dir/state" failed; fi
fi
# Closing the wrapper's descriptor is important: a detached child may still
# own it. Reconciliation will report running until the shared lock is free.
exec 9>&-
emit_result
`;
}

export function newCommandOwner(input: {
  workspace: WorkspaceRef;
  runId: string;
  attemptId: string;
  commandId?: string;
}): GuestCommandOwner {
  return {
    commandId: input.commandId ?? randomUUID(),
    workspace: input.workspace,
    runId: input.runId,
    attemptId: input.attemptId,
  };
}

/** Build the ordinary provider command that creates and fences one guest operation. */
export function buildGuestCommandRequest(input: GuestCommandRequest): CommandRequest {
  const timeoutMs = Math.max(1, input.request.timeoutMs ?? 30_000);
  return {
    command: shellCommand(input.owner, { ...input.request, timeoutMs }, input.outputMaxBytes),
    timeoutMs,
  };
}

/**
 * Build a read-only reconciliation command. It never executes the original
 * command; a running state therefore remains unresolved instead of authorizing
 * a blind rerun.
 */
export function buildGuestReconcileRequest(input: {
  owner: GuestCommandOwner;
  timeoutMs?: number;
}): CommandRequest {
  const root = rootPath(input.owner);
  const directory = statePath(input.owner);
  const resultMarker = marker(input.owner);
  const stdoutStart = `${stdoutBegin}${input.owner.commandId}`;
  const stdoutFinish = `${stdoutEnd}${input.owner.commandId}`;
  const stderrStart = `${stderrBegin}${input.owner.commandId}`;
  const stderrFinish = `${stderrEnd}${input.owner.commandId}`;
  const expectedMetadata = metadataLines(input.owner);
  return {
    command: `
set -eu
root=${quote(root)}
dir=${quote(directory)}
lock=$root/.lock
if [ -L ${quote(commandRoot)} ] || [ -L "$root" ] || [ -L "$dir" ] || [ ! -d "$dir" ] || [ ! -f "$dir/metadata" ]; then
  printf '%s\\tunknown\\t\\t0\\t0\\n' ${quote(resultMarker)}
  exit 0
fi
expected=${quote(expectedMetadata)}
actual=$(cat -- "$dir/metadata")
if [ "$actual" != "$expected" ]; then
  printf '%s\\tunknown\\t\\t0\\t0\\n' ${quote(resultMarker)}
  exit 0
fi
state=$(cat -- "$dir/state" 2>/dev/null || printf unknown)
code=$(cat -- "$dir/exit-code" 2>/dev/null || printf '')
truncated=$(cat -- "$dir/output-truncated" 2>/dev/null || printf '0')
timed_out=$(cat -- "$dir/timed-out" 2>/dev/null || printf '0')
if [ "$state" = completed ] || [ "$state" = failed ]; then
  exec 8>"$lock"
  if ! flock -n 8; then
    exec 8>&-
    printf '%s\\trunning\\t\\t%s\\t0\\n' ${quote(resultMarker)}
    exit 0
  fi
  flock -u 8
  exec 8>&-
fi
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' ${quote(resultMarker)} "$state" "$code" "$truncated" "$timed_out"
if [ "$state" = completed ] || [ "$state" = failed ]; then
  printf '%s\\n' ${quote(stdoutStart)}
  cat -- "$dir/stdout" 2>/dev/null || true
  printf '\\n%s\\n' ${quote(stdoutFinish)}
  printf '%s\\n' ${quote(stderrStart)}
  cat -- "$dir/stderr" 2>/dev/null || true
  printf '\\n%s\\n' ${quote(stderrFinish)}
fi
`,
    timeoutMs: Math.max(1, input.timeoutMs ?? 5_000),
  };
}

function parseStatusLine(
  line: string,
  owner: GuestCommandOwner,
): {
  state: CommandOperationState;
  statusCode: number | null;
  outputTruncated: boolean;
  timedOut: boolean;
} | null {
  const prefix = `${marker(owner)}\t`;
  if (!line.startsWith(prefix)) return null;
  const [, stateValue, codeValue, truncatedValue, timedOutValue] = line.split("\t");
  if (
    stateValue !== "pending" &&
    stateValue !== "running" &&
    stateValue !== "completed" &&
    stateValue !== "failed" &&
    stateValue !== "unknown"
  )
    return null;
  const statusCode = codeValue && /^-?\d+$/.test(codeValue) ? Number(codeValue) : null;
  return {
    state: stateValue,
    statusCode,
    outputTruncated: truncatedValue === "1",
    timedOut: timedOutValue === "1",
  };
}

function section(output: string, start: string, end: string): string | null {
  const startIndex = output.indexOf(`${start}\n`);
  if (startIndex < 0) return null;
  const contentStart = startIndex + start.length + 1;
  const endIndex = output.indexOf(`\n${end}`, contentStart);
  if (endIndex < 0) return null;
  return output.slice(contentStart, endIndex);
}

export function parseGuestCommandObservation(
  result: CommandResult,
  owner: GuestCommandOwner,
): GuestCommandObservation {
  if (!isProcessResult(result)) {
    return {
      state: "unknown",
      statusCode: null,
      stdout: result.stdout,
      stderr: result.stderr,
      outputTruncated: result.outputTruncated,
      timedOut: false,
      reason: result.error ?? result.kind,
    };
  }
  const status = result.stdout
    .split("\n")
    .map((line) => parseStatusLine(line.trimEnd(), owner))
    .find((value): value is NonNullable<typeof value> => value !== null);
  if (!status) {
    return {
      state: "unknown",
      statusCode: null,
      stdout: result.stdout,
      stderr: result.stderr,
      outputTruncated: result.outputTruncated,
      timedOut: false,
      reason: result.stderr || "guest command protocol response missing",
    };
  }
  const stdout = section(
    result.stdout,
    `${stdoutBegin}${owner.commandId}`,
    `${stdoutEnd}${owner.commandId}`,
  );
  const stderr = section(
    result.stdout,
    `${stderrBegin}${owner.commandId}`,
    `${stderrEnd}${owner.commandId}`,
  );
  // The initial fenced invocation intentionally emits only the status line.
  // The coordinator follows it with reconciliation to read durable output.
  if (
    (status.state === "completed" || status.state === "failed") &&
    stdout === null &&
    stderr === null
  ) {
    return {
      state: status.state,
      statusCode: status.statusCode,
      stdout: "",
      stderr: result.stderr,
      outputTruncated: status.outputTruncated || result.outputTruncated,
      timedOut: status.timedOut,
    };
  }
  if (
    (status.state === "completed" || status.state === "failed") &&
    (stdout === null || stderr === null)
  ) {
    return {
      state: "unknown",
      statusCode: null,
      stdout: "",
      stderr: result.stderr,
      outputTruncated: result.outputTruncated,
      timedOut: false,
      reason: "guest command output sections missing",
    };
  }
  return {
    state: status.state,
    statusCode: status.statusCode,
    stdout: stdout ?? "",
    stderr: stderr ?? result.stderr,
    outputTruncated: status.outputTruncated || result.outputTruncated,
    timedOut: status.timedOut,
  };
}

export function guestCommandStateIsSettled(
  state: GuestCommandObservation["state"],
): state is "completed" | "failed" {
  return state === "completed" || state === "failed";
}
