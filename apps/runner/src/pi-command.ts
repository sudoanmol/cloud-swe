import { createHash } from "node:crypto";
import { z } from "zod";
import { publicFailureMessage } from "@cloud-swe/db/public-failure";
import {
  CommandCancelledBeforeDispatchError,
  UnresolvedCommandError,
} from "./execution-coordinator.js";
import {
  isProcessResult,
  SandboxProviderError,
  transportResult,
  type CommandResult,
  type TransportCommandResult,
} from "./sandbox.js";
import { boundedUtf8 } from "./text.js";

export const defaultOutputMaxBytes = 262_144;

const maxDiagnosticBytes = 4_096;

type PiCommandOutcomeKind =
  | "completed"
  | "nonzero"
  | "transport-timeout"
  | "cancelled"
  | "unknown"
  | "output-limit";

/** Normalized, bounded diagnostics sent to both Pi and the durable event stream. */
export interface PiCommandDiagnostic {
  /** `nonzero` is a guest process result, not a transport failure. */
  kind: PiCommandOutcomeKind;
  stdout: string;
  stderr: string;
  output: string;
  diagnostic: string;
  statusCode: number | null;
  outputTruncated: boolean;
  error?: string;
}

export class PiToolExecutionError extends Error {
  readonly outcome: PiCommandDiagnostic;

  constructor(outcome: PiCommandDiagnostic) {
    super(outcome.diagnostic);
    this.name = "PiToolExecutionError";
    this.outcome = outcome;
  }
}

interface BoundedText {
  text: string;
  truncated: boolean;
}

export function positiveInteger(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;

  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);

  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Serialize arbitrary SDK tool results into bounded display text.
export function boundedValue(value: unknown, maxBytes: number): BoundedText {
  const text = z.string().safeParse(value);

  if (text.success) return boundedUtf8(text.data, maxBytes);

  try {
    const serialized = JSON.stringify(value);

    return boundedUtf8(serialized ?? String(value), maxBytes);
  } catch {
    return boundedUtf8("[unserializable tool result]", maxBytes);
  }
}

export function fingerprint(value: string): string {
  const serialized = boundedValue(value, 64 * 1024).text;

  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

function boundedStreams(
  stdout: string,
  stderr: string,
  maxBytes: number,
  providerTruncated: boolean,
) {
  const stdoutPart = boundedUtf8(stdout, maxBytes);
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(stdoutPart.text, "utf8"));
  const stderrPart = boundedUtf8(stderr, remaining);
  const combined = stderrPart.text ? `${stdoutPart.text}\n${stderrPart.text}` : stdoutPart.text;
  const outputPart = boundedUtf8(combined, maxBytes);
  const inputBytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");

  return {
    stdout: stdoutPart.text,
    stderr: stderrPart.text,
    output: outputPart.text,
    truncated:
      providerTruncated ||
      stdoutPart.truncated ||
      stderrPart.truncated ||
      outputPart.truncated ||
      inputBytes > maxBytes,
  };
}

function diagnosticText(
  kind: PiCommandOutcomeKind,
  statusCode: number | null,
  output: string,
  truncated: boolean,
  error: string | undefined,
  maxBytes: number,
): string {
  const status = statusCode === null ? "status unavailable" : `exit code ${statusCode}`;
  const lines = [`remote command ${kind} (${status})`];

  if (output) lines.push(output);

  if (error) lines.push(error);

  if (truncated) lines.push("[output truncated]");

  return boundedUtf8(lines.join("\n"), Math.min(maxBytes, maxDiagnosticBytes)).text;
}

function normalizedDiagnostic(
  kind: PiCommandOutcomeKind,
  stdout: string,
  stderr: string,
  statusCode: number | null,
  outputTruncated: boolean,
  error: string | undefined,
  maxBytes: number,
): PiCommandDiagnostic {
  const streams = boundedStreams(stdout, stderr, maxBytes, outputTruncated);

  const diagnostic = diagnosticText(
    kind,
    statusCode,
    streams.output,
    streams.truncated,
    error,
    maxBytes,
  );

  const boundedError = error
    ? boundedUtf8(error, Math.min(maxBytes, maxDiagnosticBytes)).text
    : undefined;

  return {
    kind,
    stdout: streams.stdout,
    stderr: streams.stderr,
    output: streams.output,
    diagnostic,
    statusCode,
    outputTruncated: streams.truncated,
    ...(boundedError ? { error: boundedError } : undefined),
  };
}

/**
 * Normalize a provider result without turning a non-zero guest exit into a
 * transport exception. The coordinator's transport variants remain failures
 * for Pi after their bounded diagnostics have been persisted.
 */
export function normalizePiCommandResult(
  result: CommandResult,
  maxBytes = defaultOutputMaxBytes,
): PiCommandDiagnostic {
  const limit = positiveInteger(maxBytes, "outputMaxBytes", defaultOutputMaxBytes);

  if (isProcessResult(result)) {
    const processKind: PiCommandOutcomeKind = result.statusCode === 0 ? "completed" : "nonzero";
    // Bounding is applied in normalizedDiagnostic. A process result that does
    // not survive the shared byte limit is a distinct output-limit outcome,
    // not a plain completed/nonzero tool result.
    const streams = boundedStreams(result.stdout, result.stderr, limit, result.outputTruncated);
    const kind: PiCommandOutcomeKind = streams.truncated ? "output-limit" : processKind;

    return normalizedDiagnostic(
      kind,
      result.stdout,
      result.stderr,
      result.statusCode,
      result.outputTruncated,
      undefined,
      limit,
    );
  }

  const transport: TransportCommandResult = result;

  return normalizedDiagnostic(
    transport.kind,
    transport.stdout,
    transport.stderr,
    transport.statusCode,
    transport.outputTruncated,
    transport.error ? publicFailureMessage(transport.error) : undefined,
    limit,
  );
}

/**
 * Map a typed coordinator/provider error to a transport result that preserves
 * its diagnostic. Unknown outcomes stay fatal upstream: the workspace must
 * reconcile or quarantine before another mutating command runs.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Classify a caught coordinator or SDK rejection without assuming it is an Error.
export function coordinatorTransport(error: unknown): TransportCommandResult | undefined {
  if (error instanceof CommandCancelledBeforeDispatchError)
    return transportResult("cancelled", publicFailureMessage(error.message));

  if (error instanceof UnresolvedCommandError)
    return transportResult("unknown", publicFailureMessage(error.message));

  if (error instanceof SandboxProviderError) {
    const message = publicFailureMessage(error.message);

    if (error.kind === "timeout") return transportResult("transport-timeout", message);

    if (error.kind === "cancelled") return transportResult("cancelled", message);

    if (error.kind === "unknown") return transportResult("unknown", message);
  }

  return undefined;
}

export function transportFromThrownError(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This adapter converts arbitrary thrown values into a transport diagnostic.
  error: unknown,
  signal: AbortSignal,
  maxBytes: number,
): PiCommandDiagnostic {
  const message =
    error instanceof Error
      ? error.message
      : (z.string().safeParse(error).data ?? "sandbox command failed");

  const typed = coordinatorTransport(error);

  if (typed) return normalizePiCommandResult(typed, maxBytes);
  const lower = message.toLowerCase();
  let kind: PiCommandOutcomeKind = "unknown";

  if (signal.aborted || lower.includes("cancel") || lower.includes("abort")) kind = "cancelled";
  else if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline"))
    kind = "transport-timeout";
  else if (lower.includes("output") && (lower.includes("limit") || lower.includes("exceed")))
    kind = "output-limit";

  return normalizedDiagnostic(
    kind,
    "",
    "",
    null,
    kind === "output-limit",
    publicFailureMessage(message),
    maxBytes,
  );
}

export function commandPayload(outcome: PiCommandDiagnostic) {
  return {
    kind: outcome.kind,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    output: outcome.output,
    diagnostic: outcome.diagnostic,
    statusCode: outcome.statusCode,
    outputTruncated: outcome.outputTruncated,
    error: outcome.error || undefined,
  };
}
