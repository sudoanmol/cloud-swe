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
  /**
   * Settled guest output is present. A completed/failed status without
   * sections still needs reconciliation; do not treat empty strings as the
   * durable result.
   */
  outputAvailable: boolean;
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

function metadataText(owner: GuestCommandOwner): string {
  return `${[
    `commandId=${owner.commandId}`,
    `workspaceId=${owner.workspace.id}`,
    `threadId=${owner.workspace.threadId}`,
    `workspaceName=${owner.workspace.name}`,
    `provider=${owner.workspace.provider}`,
    `generation=${owner.workspace.generation}`,
    `runId=${owner.runId}`,
    `attemptId=${owner.attemptId}`,
  ].join("\n")}\n`;
}

function outputSectionShell(owner: GuestCommandOwner): string {
  const stdoutStart = `${stdoutBegin}${owner.commandId}`;
  const stdoutFinish = `${stdoutEnd}${owner.commandId}`;
  const stderrStart = `${stderrBegin}${owner.commandId}`;
  const stderrFinish = `${stderrEnd}${owner.commandId}`;
  return `
  printf '%s\\n' ${quote(stdoutStart)}
  cat -- "$dir/stdout" 2>/dev/null || true
  printf '\\n%s\\n' ${quote(stdoutFinish)}
  printf '%s\\n' ${quote(stderrStart)}
  cat -- "$dir/stderr" 2>/dev/null || true
  printf '\\n%s\\n' ${quote(stderrFinish)}
`;
}

function shellCommand(
  owner: GuestCommandOwner,
  request: CommandRequest,
  outputMaxBytes: number,
): string {
  const root = rootPath(owner);
  const directory = statePath(owner);
  const commandEncoded = encode(request.command);
  const timeoutSeconds = Math.max(1, Math.ceil(Math.max(1, request.timeoutMs ?? 30_000) / 1_000));
  const maxBytes = Math.max(2, Math.floor(outputMaxBytes));
  const resultMarker = marker(owner);
  const expectedMetadata = metadataText(owner);
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
  printf '%s' ${quote(expectedMetadata)} | cmp -s -- "$dir/metadata" -
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
  if [ "$state" = completed ] || [ "$state" = failed ]; then
${outputSectionShell(owner)}
  fi
}
# Bound the journal without waiting for EOF. After head stops, cat keeps
# the fifo open so a background writer is not SIGPIPEd. Never kill this
# reader: closing the pipe can take down an inherited dev server.
drain_stream() {
  fifo=$1
  capture=$2
  limit=$3
  flag=$4
  trap '' HUP
  exec 8>&-
  exec 9>&-
  if command -v stdbuf >/dev/null 2>&1; then
    { stdbuf -o0 head -c $((limit + 1)) >"$capture"; cat >/dev/null; } <"$fifo"
  else
    { head -c $((limit + 1)) >"$capture"; cat >/dev/null; } <"$fifo"
  fi
  bytes=$(wc -c <"$capture")
  if [ "$bytes" -gt "$limit" ]; then
    printf '1' >"$flag"
  fi
}
# Copy the current bounded capture. The reader still owns the live file.
snapshot_bounded() {
  capture=$1
  output=$2
  limit=$3
  flag=$4
  if [ ! -f "$capture" ]; then
    : >"$output"
    return
  fi
  head -c "$limit" -- "$capture" >"$output.tmp"
  bytes=$(wc -c <"$capture")
  if [ "$bytes" -gt "$limit" ]; then
    printf '1' >"$flag"
  fi
  mv -f -- "$output.tmp" "$output"
}
# Drain the kernel pipe into the capture file. Do not wait for the reader
# to see EOF: a background child may hold the write end forever.
# A missing capture is not stable: head creates the file when it starts.
# Do not treat a zero-byte file as settled on the first equal pair.
wait_capture_stable() {
  capture=$1
  i=0
  prev=""
  while [ "$i" -lt 6 ]; do
    if [ ! -f "$capture" ]; then
      i=$((i + 1))
      sleep 0.05
      continue
    fi
    cur=$(wc -c <"$capture" 2>/dev/null || printf 0)
    if [ "$i" -gt 2 ] && [ "$cur" = "$prev" ]; then
      return
    fi
    prev=$cur
    i=$((i + 1))
    sleep 0.05
  done
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
# User stdin arrives on this process's stdin, not argv. Embedding a payload
# here hits ARG_MAX around 128KiB on docker exec / Freestyle command.
cat >"$dir/stdin"
: >"$dir/stdout"
: >"$dir/stderr"
rm -f -- "$dir/inner-exit" "$dir/inner-exit.tmp" "$dir/stdout.pipe" "$dir/stderr.pipe" "$dir/stdout.capture" "$dir/stderr.capture"
write_atomic "$dir/output-truncated" 0
write_atomic "$dir/timed-out" 0
write_atomic "$dir/state" pending
exec 9>"$lock"
flock -x 9
existing=$(cat -- "$dir/state")
if [ "$existing" = completed ] || [ "$existing" = failed ] || [ "$existing" = running ]; then
  exec 9>&-
  emit_result
  exit 0
fi
write_atomic "$dir/state" running
stdout_limit=$(( ${maxBytes} / 2 ))
stderr_limit=$(( ${maxBytes} - stdout_limit ))
[ "$stdout_limit" -lt 1 ] && stdout_limit=1
[ "$stderr_limit" -lt 1 ] && stderr_limit=1
mkfifo -- "$dir/stdout.pipe" "$dir/stderr.pipe"
( exec 8>&-; exec 9>&-; drain_stream "$dir/stdout.pipe" "$dir/stdout.capture" "$stdout_limit" "$dir/output-truncated" ) &
( exec 8>&-; exec 9>&-; drain_stream "$dir/stderr.pipe" "$dir/stderr.capture" "$stderr_limit" "$dir/output-truncated" ) &
set +e
# Close the lock fd before command.sh so an unredirected background child
# cannot pin it. Readers stay up after this parent exits and keep draining.
timeout --kill-after=5s ${quote(`${timeoutSeconds}s`)} sh -c '
  exec 8>&-
  exec 9>&-
  command_dir=$1
  sh "$command_dir/command.sh"
  code=$?
  tmp="$command_dir/inner-exit.tmp"
  printf %s "$code" >"$tmp"
  mv -f -- "$tmp" "$command_dir/inner-exit"
' sh "$dir" <"$dir/stdin" >"$dir/stdout.pipe" 2>"$dir/stderr.pipe" 8>&- 9>&-
set -e
if [ -f "$dir/inner-exit" ]; then
  code=$(cat -- "$dir/inner-exit")
  timed_out=0
else
  # timeout removed the wrapper before it could record an exit. A user
  # command that itself exits 124 still writes inner-exit and is not a timeout.
  timed_out=1
  code=124
fi
wait_capture_stable "$dir/stdout.capture"
wait_capture_stable "$dir/stderr.capture"
snapshot_bounded "$dir/stdout.capture" "$dir/stdout" "$stdout_limit" "$dir/output-truncated"
snapshot_bounded "$dir/stderr.capture" "$dir/stderr" "$stderr_limit" "$dir/output-truncated"
write_atomic "$dir/timed-out" "$timed_out"
if [ "$timed_out" -eq 1 ]; then
  write_atomic "$dir/exit-code" 124
  write_atomic "$dir/state" failed
else
  write_atomic "$dir/exit-code" "$code"
  if [ "$code" -eq 0 ]; then write_atomic "$dir/state" completed; else write_atomic "$dir/state" failed; fi
fi
# Children were started with fd 9 closed. Release the wrapper's lock now.
# Do not wait for or kill drain readers: they discard further output.
exec 9>&-
emit_result
`;
}

export function newCommandOwner(input: {
  workspace: WorkspaceRef;
  runId: string;
  attemptId: string;
}): GuestCommandOwner {
  return {
    commandId: randomUUID(),
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
    // Always attach a closed stdin channel so `cat >"$dir/stdin"` cannot hang.
    stdin: input.request.stdin ?? "",
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
  const expectedMetadata = metadataText(input.owner);
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
if ! printf '%s' ${quote(expectedMetadata)} | cmp -s -- "$dir/metadata" -; then
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
${outputSectionShell(input.owner)}
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

function unknownObservation(
  result: Pick<CommandResult, "stdout" | "stderr" | "outputTruncated">,
  reason: string,
): GuestCommandObservation {
  return {
    state: "unknown",
    statusCode: null,
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.outputTruncated,
    timedOut: false,
    outputAvailable: false,
    reason,
  };
}

export function parseGuestCommandObservation(
  result: CommandResult,
  owner: GuestCommandOwner,
): GuestCommandObservation {
  if (!isProcessResult(result)) {
    return unknownObservation(result, result.error ?? result.kind);
  }
  const status = result.stdout
    .split("\n")
    .map((line) => parseStatusLine(line.trimEnd(), owner))
    .find((value): value is NonNullable<typeof value> => value !== null);
  if (!status)
    return unknownObservation(result, result.stderr || "guest command protocol response missing");
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
  if (status.state === "completed" || status.state === "failed") {
    if (stdout === null && stderr === null) {
      return {
        state: status.state,
        statusCode: status.statusCode,
        stdout: "",
        stderr: result.stderr,
        outputTruncated: status.outputTruncated || result.outputTruncated,
        timedOut: status.timedOut,
        outputAvailable: false,
      };
    }
    if (stdout === null || stderr === null) {
      return unknownObservation(result, "guest command output sections missing");
    }
    return {
      state: status.state,
      statusCode: status.statusCode,
      stdout,
      stderr,
      outputTruncated: status.outputTruncated || result.outputTruncated,
      timedOut: status.timedOut,
      outputAvailable: true,
    };
  }
  return {
    state: status.state,
    statusCode: status.statusCode,
    stdout: "",
    stderr: result.stderr,
    outputTruncated: status.outputTruncated || result.outputTruncated,
    timedOut: status.timedOut,
    outputAvailable: false,
  };
}

export function guestCommandStateIsSettled(
  state: GuestCommandObservation["state"],
): state is "completed" | "failed" {
  return state === "completed" || state === "failed";
}
