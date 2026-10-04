import { piSystemPrompt, type PiEnvironment } from "./pi-system-prompt.js";
import type { PiGitTools } from "./git-tools.js";
import type { GitProposal } from "@cloud-swe/db/git-contracts";
import type { QuestionRequestPayload } from "@cloud-swe/db/question-contracts";
import type { PiQuestionTools } from "./question-tools.js";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { modelProviders } from "@cloud-swe/db/model-selection";
import { boundedUtf8 } from "./text.js";
import { commandStdoutMaxBytes } from "./guest-command.js";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type AgentToolResult,
  type FileEntry,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expandRemoteSkill, type RemoteResources } from "./remote-resources.js";
import { createHash } from "node:crypto";
import {
  buildRemoteReadCommand,
  buildRemoteWriteCommand,
  remoteFileCommand,
  editResultSchema,
  writeResultSchema,
} from "./remote-files.js";

import { Type } from "typebox";
import { z } from "zod";
import { Deferred, Effect, Match } from "effect";
import type { Logger } from "pino";
import {
  decodePiSessionCheckpoint,
  parseProjectToolFailure,
  type PiAttachmentImageReference,
  type PiSessionCheckpoint,
} from "@cloud-swe/db/checkpoint";
import { jsonValueSchema, type JsonObject } from "@cloud-swe/db/json";
import { decodeStructuredToolResult } from "@cloud-swe/db/tool-events";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";
import { publicFailureMessage } from "@cloud-swe/db/public-failure";
import {
  piOperation,
  PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS,
  PiPersistenceWriter,
  type Awaitable,
  type PiWriterCompletionOptions,
} from "./pi-persistence.js";
import {
  CommandCancelledBeforeDispatchError,
  UnresolvedCommandError,
} from "./execution-coordinator.js";
import {
  isProcessResult,
  SandboxProviderError,
  transportResult,
  type CommandProgressObserver,
  type CommandRequest,
  type CommandResult,
  type SandboxProvider,
  type TransportCommandResult,
  type WorkspaceRef,
} from "./sandbox.js";

const workspaceRoot = "/workspace";

const defaultOutputMaxBytes = 262_144;

const defaultCheckpointMaxBytes = 4_194_304;

const maxDiagnosticBytes = 4_096;

/** Streamed text is coalesced for at most this long before it is written. */
const deltaFlushMs = 100;

const deltaFlushChars = 4_096;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate SDK tool arguments before projecting bounded event metadata.
function boundedEditArgs(args: unknown) {
  const parsed = z
    .object({
      path: z.string(),
      edits: z.array(z.object({ oldText: z.string(), newText: z.string() })),
    })
    .safeParse(args);

  if (!parsed.success) return { invalid: true };

  return {
    path: parsed.data.path.slice(0, 4096),
    edits: parsed.data.edits.length,
    oldTextBytes: parsed.data.edits.reduce((sum, edit) => sum + Buffer.byteLength(edit.oldText), 0),
    newTextBytes: parsed.data.edits.reduce((sum, edit) => sum + Buffer.byteLength(edit.newText), 0),
  };
}

/** Bound the durable write preview; the full arguments stay in the Pi checkpoint. */
const writeArgumentPreviewBytes = 4_096;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate SDK tool arguments before projecting bounded event metadata.
function boundedWriteArgs(args: unknown) {
  const parsed = z.object({ path: z.string(), content: z.string() }).safeParse(args);

  if (!parsed.success) return { invalid: true };

  const preview = boundedUtf8(parsed.data.content, writeArgumentPreviewBytes);

  return {
    path: parsed.data.path.slice(0, 4096),
    contentBytes: Buffer.byteLength(parsed.data.content),
    contentPreview: preview.text,
    contentPreviewTruncated: preview.truncated,
  };
}

/**
 * Project allowlisted structured tool details for the transcript.
 *
 * Editing and web tools already return bounded `details`; the decoder also
 * normalizes legacy shapes and rejects truncated stringified wrappers so a
 * reader falls back to plain text instead of parsing invalid JSON.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate SDK tool details at the runner event boundary.
function structuredToolResult(toolName: string, result: unknown) {
  const wrapper = z.object({ details: z.unknown() }).safeParse(result);

  return decodeStructuredToolResult(wrapper.success ? wrapper.data.details : result, toolName);
}

const defaultCommandTimeoutSeconds = 120;

const maxCommandTimeoutSeconds = 600;

const pathParameter = Type.String({
  description: "File path under /workspace or /tmp (relative paths resolve from /workspace)",
});

const bashParameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: `Timeout in seconds (default ${defaultCommandTimeoutSeconds}, maximum ${maxCommandTimeoutSeconds})`,
      minimum: 1,
      maximum: maxCommandTimeoutSeconds,
    }),
  ),
});

const readParameters = Type.Object({
  path: pathParameter,
  offset: Type.Optional(
    Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Maximum number of lines to read" }),
  ),
});

const writeParameters = Type.Object({
  path: pathParameter,
  content: Type.String({ description: "Content to write to the file" }),
});

const editParameters = Type.Object({
  path: pathParameter,
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description:
          "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
      }),
      newText: Type.String({ description: "Replacement text for this targeted edit." }),
    }),
    {
      minItems: 1,
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    },
  ),
});

const PI_TOOL_NAMES = ["bash", "read", "write", "edit"] as const;

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type PiEventType =
  | "assistant.started"
  | "assistant.delta"
  | "assistant.reasoning.delta"
  | "assistant.message"
  | "tool.started"
  | "tool.output"
  | "tool.completed";

export interface PiEvent {
  type: PiEventType;
  dedupeKey: string;
  payload: JsonObject;
}

export interface PiAttemptOptions {
  /** Activity-attempt identity. Retries must supply a new value. */
  attemptId: string;
  /** Filesystem generation used by this Pi attempt. */
  workspaceGeneration: number;
  /** Shared stdout/stderr byte limit for remote tools. */
  outputMaxBytes: number;
  /** Maximum serialized resumable-session checkpoint size. */
  checkpointMaxBytes: number;
}

export interface PiExecutorConfig {
  git?: PiGitTools;
  questions?: PiQuestionTools;
  webTools?: ToolDefinition[];
  environment?: PiEnvironment;
  resources?: RemoteResources;
  sandbox: Pick<SandboxProvider, "exec">;
  workspace: WorkspaceRef;
  /** Provider persisted with the run. */
  piProvider?: string;
  /** Model persisted with the run. */
  piModel?: string;
  thinkingLevel?: PiThinkingLevel;
  credentials?: CredentialStore;
  /** Worker-level default for the shared stdout/stderr byte limit. */
  outputMaxBytes?: number;
  /** Worker-level default for the serialized resumable-session checkpoint size. */
  checkpointMaxBytes?: number;
  /** Cleanup budget for persistence acknowledgements and session aborts. */
  persistenceCleanupTimeoutMs?: number;
  emit: (event: PiEvent) => Awaitable<void>;
  /** Persists the resumable session checkpoint, not the completion checkpoint. */
  checkpoint?: (
    metadata: PiPersistedSessionMetadata,
    proposal?: GitProposal,
    questionRequest?: QuestionRequestPayload,
  ) => Awaitable<void>;
  /** Structured logger for secondary cleanup diagnostics. */
  logger?: Pick<Logger, "warn">;
}

export interface PiExecutorInput {
  prompt: string;
  signal?: AbortSignal;
  runId: string;
  /** Activity-attempt identity. Every retry supplies a new value. */
  attemptId: string;
  /** Workspace generation observed by the activity owner. */
  workspaceGeneration: number;
  /** Per-attempt limit overrides supplied by the activity owner. */
  outputMaxBytes?: number;
  checkpointMaxBytes?: number;
  sessionEntries?: FileEntry[];
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  checkpointImages?: PiAttachmentImageReference[];
  workspace?: WorkspaceRef;
}

/**
 * Metadata for the resumable `pi-session` checkpoint. The reliability fields
 * are optional for decoding pre-contract checkpoints; newly produced metadata
 * always includes them.
 */
export interface PiSessionMetadata {
  sessionId: string;
  provider: string;
  model: string;
  entries: FileEntry[];
  runId?: string;
  attemptId?: string;
  workspaceGeneration?: number;
  assistantAttempt?: number;
}

export type PiPersistedSessionMetadata = Omit<PiSessionMetadata, "entries"> & {
  version: 2;
  entries: Extract<PiSessionCheckpoint, { version: 2 }>["entries"];
};

export interface PiExecutorOutput {
  approval?: GitProposal;
  questionRequest?: QuestionRequestPayload;
  text: string;
  session: PiPersistedSessionMetadata;
}

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

class PiToolExecutionError extends Error {
  readonly outcome: PiCommandDiagnostic;

  constructor(outcome: PiCommandDiagnostic) {
    super(outcome.diagnostic);
    this.name = "PiToolExecutionError";
    this.outcome = outcome;
  }
}

export class PiCheckpointLimitError extends Error {
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(sizeBytes: number, limitBytes: number) {
    super(`Pi session checkpoint is ${sizeBytes} bytes; configured limit is ${limitBytes} bytes`);
    this.name = "PiCheckpointLimitError";
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

export class PiCheckpointSerializationError extends Error {
  constructor() {
    super("Pi session checkpoint is not JSON serializable");
    this.name = "PiCheckpointSerializationError";
  }
}

interface BoundedText {
  text: string;
  truncated: boolean;
}

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;

  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);

  return value;
}

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON payloads are already validated at their event boundary.
function deepFreeze<T>(value: T): T {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The event payload is a validated JSON object.
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;

  for (const child of Object.values(value)) deepFreeze(child);

  return Object.freeze(value);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Serialize arbitrary SDK tool results into bounded display text.
function boundedValue(value: unknown, maxBytes: number): BoundedText {
  const text = z.string().safeParse(value);

  if (text.success) return boundedUtf8(text.data, maxBytes);

  try {
    const serialized = JSON.stringify(value);

    return boundedUtf8(serialized ?? String(value), maxBytes);
  } catch {
    return boundedUtf8("[unserializable tool result]", maxBytes);
  }
}

function fingerprint(value: string): string {
  const serialized = boundedValue(value, 64 * 1024).text;

  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

export function piAttemptEventIdentity(runId: string, attemptId: string): string {
  return `run:${runId}:attempt:${attemptId}`;
}

export interface AttemptScopedEvent {
  type: string;
  dedupeKey: string;
  payload: JsonObject;
}

/**
 * Envelope for Pi events. Pi already scopes its dedupe keys and payload to
 * the attempt, so the key passes through once while the activity-owned run
 * and attempt ids win over anything in the payload.
 */
export function scopePiAttemptEvent(
  runId: string,
  attemptId: string,
  event: AttemptScopedEvent,
): AttemptScopedEvent {
  return {
    type: event.type,
    payload: { ...event.payload, runId, attemptId },
    dedupeKey: event.dedupeKey,
  };
}

/** Scripted events carry no attempt identity, so the activity adds its scope. */
export function scopeScriptedAttemptEvent(
  runId: string,
  attemptId: string,
  event: AttemptScopedEvent,
): AttemptScopedEvent {
  return {
    type: event.type,
    payload: { ...event.payload, runId, attemptId },
    dedupeKey: `${piAttemptEventIdentity(runId, attemptId)}:${event.dedupeKey}`,
  };
}

export function assistantStartedDedupeKey(
  runId: string,
  attemptId: string,
  assistantAttempt: number,
  messageIndex: number,
): string {
  return `${piAttemptEventIdentity(runId, attemptId)}:assistant:${assistantAttempt}:${messageIndex}:started`;
}

export function assistantDeltaDedupeKey(
  runId: string,
  attemptId: string,
  assistantAttempt: number,
  messageIndex: number,
  deltaIndex: number,
): string {
  return `${piAttemptEventIdentity(runId, attemptId)}:assistant:${assistantAttempt}:${messageIndex}:delta:${deltaIndex}`;
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

function transportFromThrownError(
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

function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return { content: [{ type: "text", text }], details };
}

type PiAgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type PiSessionLike = Pick<
  PiAgentSession,
  "sessionId" | "messages" | "subscribe" | "prompt" | "abort" | "dispose"
> & { agent?: Pick<PiAgentSession["agent"], "finishTurn"> };

type CreateAgentSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

type PiSessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: PiSessionLike }>;

/**
 * Dependency seam for deterministic executor tests. The worker uses the
 * published SDK factory when this is omitted; it does not provide a production
 * alternate session implementation.
 */
export interface PiExecutorDependencies {
  createAgentSession?: PiSessionFactory;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK creation rejects with arbitrary provider values at this cancellation boundary.
async function createPiSession(
  factory: PiSessionFactory,
  options: CreateAgentSessionOptions,
  signal: AbortSignal,
): Promise<{ session: PiSessionLike }> {
  signal.throwIfAborted();
  const pending = factory(options);

  return new Promise<{ session: PiSessionLike }>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      settled = true;
      reject(signal.reason ?? new Error("Pi session creation cancelled"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (created) => {
        signal.removeEventListener("abort", onAbort);

        if (settled || signal.aborted) {
          void Promise.resolve()
            .then(() => created.session.dispose())
            .catch(() => undefined);

          return;
        }

        settled = true;
        resolve(created);
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the SDK rejection for the caller.
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);

        if (!settled) {
          settled = true;
          reject(error);
        }
      },
    );
  });
}

async function disposePiSession(
  session: PiSessionLike,
  logger: Pick<Logger, "warn"> | undefined,
): Promise<void> {
  try {
    await Effect.runPromise(
      piOperation(() => Promise.resolve(session.dispose()), {
        timeoutMs: PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS,
      }),
    );
  } catch {
    logger?.warn({ resource: "pi-session" }, "Pi session cleanup failed");
  }
}

function textFromMessages(session: Pick<PiAgentSession, "messages">): string {
  let text = "";

  for (const message of session.messages) {
    if (message.role !== "assistant") continue;
    text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  return text;
}

/** Keep the SDK's request-time auth resolution, with no ambient worker keys. */
export async function createPiModelRuntime(credentials: CredentialStore, providerId: string) {
  const provider = modelProviders.find((candidate) => candidate.id === providerId);

  if (!provider) throw new Error("Unsupported model provider");

  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });

  runtime.registerNativeProvider({
    ...provider,
    auth:
      providerId === "openai-codex"
        ? provider.auth
        : {
            apiKey: {
              name: provider.name,
              resolve: async ({ credential }) =>
                credential?.key ? { auth: { apiKey: credential.key } } : undefined,
            },
          },
  });

  return runtime;
}

/**
 * Synchronous getters use only a captured remote snapshot. Worker-global
 * resources, native skill expansion and JavaScript extensions stay disabled.
 */
export function createPiResourceLoader(
  resources?: RemoteResources,
  systemAppend?: string,
): ResourceLoader {
  const extensionRuntime = createExtensionRuntime();

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: resources?.instructions ?? [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [
      ...(resources?.catalog ? [resources.catalog] : []),
      ...(systemAppend ? [systemAppend] : []),
    ],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate persisted checkpoint metadata at the read boundary.
export function parsePiSessionMetadata(value: unknown): PiSessionCheckpoint | undefined {
  try {
    return decodePiSessionCheckpoint(value);
  } catch {
    return undefined;
  }
}

function resolvePiAttemptOptions(
  config: PiExecutorConfig,
  input: PiExecutorInput,
  workspace: WorkspaceRef,
): PiAttemptOptions {
  if (!input.attemptId) throw new Error("Pi attemptId is required");

  return {
    attemptId: input.attemptId,
    workspaceGeneration: input.workspaceGeneration ?? workspace.generation,
    outputMaxBytes: positiveInteger(
      input.outputMaxBytes ?? config.outputMaxBytes,
      "outputMaxBytes",
      defaultOutputMaxBytes,
    ),
    checkpointMaxBytes: positiveInteger(
      input.checkpointMaxBytes ?? config.checkpointMaxBytes,
      "checkpointMaxBytes",
      defaultCheckpointMaxBytes,
    ),
  };
}

export function serializedPiCheckpointBytes(
  metadata: PiSessionMetadata | PiPersistedSessionMetadata,
): number {
  try {
    const payload = {
      kind: "pi",
      ...metadata,
      version: "version" in metadata ? metadata.version : 2,
    };

    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    throw new PiCheckpointSerializationError();
  }
}

function checkpointImageKey(input: {
  data?: string;
  sha256?: string;
  mimeType: string;
  size?: number;
}) {
  if (input.data !== undefined) {
    const data = Buffer.from(input.data, "base64");

    return `${createHash("sha256").update(data).digest("hex")}:${input.mimeType}:${data.byteLength}`;
  }

  return `${input.sha256}:${input.mimeType}:${input.size}`;
}

function referenceCheckpointImages(
  metadata: PiSessionMetadata,
  references: PiAttachmentImageReference[],
): PiPersistedSessionMetadata {
  const queues = new Map<string, PiAttachmentImageReference[]>();

  for (const reference of references) {
    const key = checkpointImageKey(reference);
    queues.set(key, [...(queues.get(key) ?? []), reference]);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Recursively rewrite validated Pi entry JSON, then validate the complete checkpoint below.
  const replace = (value: unknown): unknown => {
    const image = z
      .object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })
      .safeParse(value);

    if (image.success) return queues.get(checkpointImageKey(image.data))?.shift() ?? value;

    if (Array.isArray(value)) return value.map(replace);

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establish the JSON object branch before enumerating its validated children.
    if (typeof value !== "object" || value === null) return value;

    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
  };

  const checkpoint = decodePiSessionCheckpoint({
    ...metadata,
    version: 2,
    entries: metadata.entries.map(replace),
  });

  if (checkpoint.version !== 2) throw new PiCheckpointSerializationError();

  return checkpoint;
}

export function assertPiCheckpointSize(
  metadata: PiSessionMetadata | PiPersistedSessionMetadata,
  limitBytes: number,
): void {
  const sizeBytes = serializedPiCheckpointBytes(metadata);

  if (sizeBytes > limitBytes) throw new PiCheckpointLimitError(sizeBytes, limitBytes);
}

function commandPayload(outcome: PiCommandDiagnostic) {
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

export function createPiExecutor(
  config: PiExecutorConfig,
  dependencies: PiExecutorDependencies = {},
) {
  return async function execute(input: PiExecutorInput): Promise<PiExecutorOutput> {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const workspace = input.workspace ?? config.workspace;
    const attempt = resolvePiAttemptOptions(config, input, workspace);

    const persistenceCleanupTimeoutMs = positiveInteger(
      config.persistenceCleanupTimeoutMs,
      "persistenceCleanupTimeoutMs",
      PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS,
    );

    const injectedSessionFactory = dependencies.createAgentSession;
    const provider = config.piProvider?.trim();
    const modelId = config.piModel?.trim();
    const credentials = config.credentials;
    let runtime: ModelRuntime | undefined;
    let model: CreateAgentSessionOptions["model"];

    if (!injectedSessionFactory) {
      if (!provider) throw new Error("Pi provider is required");

      if (!modelId) throw new Error("Pi model is required");

      if (!credentials) throw new Error("Model credentials are required");

      runtime = await createPiModelRuntime(credentials, provider);
      model = runtime.getModel(provider, modelId);

      if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);
    }

    const modelProvider = model?.provider ?? provider ?? "injected";
    const modelIdentifier = model?.id ?? modelId ?? "injected";

    const sessionManager = input.sessionEntries
      ? SessionManager.inMemory(workspaceRoot, undefined, input.sessionEntries)
      : SessionManager.inMemory(workspaceRoot);

    const settingsManager = SettingsManager.inMemory({
      defaultTools: [],
      compaction: { enabled: false },
      retry: { enabled: false },
    });

    const resourceLoader = createPiResourceLoader(
      config.resources,
      piSystemPrompt(
        workspace,
        [
          ...PI_TOOL_NAMES,
          ...(config.git?.tools.map((tool) => tool.name) ?? []),
          ...(config.questions?.tools.map((tool) => tool.name) ?? []),
          ...(config.webTools?.map((tool) => tool.name) ?? []),
        ],
        attempt.outputMaxBytes,
        config.environment,
      ),
    );

    const toolOutcomes = new Map<string, PiCommandDiagnostic>();
    let toolOutputIndex = 0;
    let deltaIndex = 0;
    /**
     * Turn identity: increments once per SDK agent start, so a retried or
     * continued turn never shares an assistant identity with an earlier one.
     * A question continuation is a new activity attempt with a fresh id.
     */
    let assistantAttempt = 0;
    /** Per-assistant-message index inside one turn attempt, starting at 1. */
    let messageIndex = 0;
    /** Last streamed thinking block of the current message, to separate blocks. */
    let reasoningContentIndex: number | undefined;

    /**
     * Providers stream a few characters per delta. Consecutive pieces of one
     * kind for one message are written as a single delta event; readers only
     * concatenate, so the projected text is unchanged.
     */
    let pendingDelta:
      | {
          type: "assistant.delta" | "assistant.reasoning.delta";
          assistantAttempt: number;
          messageIndex: number;
          text: string;
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined;

    let session: PiSessionLike;
    let writer: PiPersistenceWriter;
    let writerCleanupStarted = false;

    let completeWriter: (options?: PiWriterCompletionOptions) => Promise<void>;

    const persistenceFailure = Deferred.makeUnsafe<never, unknown>();
    let abortOperation: Promise<void> | undefined;

    const abortSession = (): Promise<void> => {
      if (!abortOperation) {
        abortOperation = (async () => {
          try {
            await session.abort();
          } catch {
            // The caller's failure remains authoritative if abort itself fails.
          }
        })();
      }

      return abortOperation;
    };

    let latchedTransportError: PiToolExecutionError | UnresolvedCommandError | undefined;

    const latchTransportError = (
      outcome: PiCommandDiagnostic,
      failure?: UnresolvedCommandError,
    ) => {
      if (!latchedTransportError) {
        latchedTransportError = failure ?? new PiToolExecutionError(outcome);
        void abortSession();
      }

      return latchedTransportError;
    };

    const eventIdentity = piAttemptEventIdentity(input.runId, attempt.attemptId);

    const withMetadata = (payload: JsonObject): JsonObject => ({
      ...payload,
      runId: input.runId,
      attemptId: attempt.attemptId,
    });

    const writeEvent = (
      type: PiEventType,
      dedupeKey: string,
      payload: JsonObject,
    ): Promise<void> => {
      const event = {
        type,
        dedupeKey,
        payload: withMetadata(payload),
      } satisfies PiEvent;

      const sizeBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      const captured = deepFreeze(event);

      return writer.enqueue(() => config.emit(captured), {
        kind: "event",
        sizeBytes,
      });
    };

    const queueEvent = (type: PiEventType, dedupeKey: string, payload: JsonObject): void => {
      void writeEvent(type, dedupeKey, payload).catch(() => undefined);
    };

    const flushDelta = (): void => {
      if (!pendingDelta) return;
      const { type, assistantAttempt: turn, messageIndex: index, text, timer } = pendingDelta;
      pendingDelta = undefined;
      clearTimeout(timer);
      const currentDeltaIndex = deltaIndex++;

      if (type === "assistant.delta")
        queueEvent(
          type,
          assistantDeltaDedupeKey(input.runId, attempt.attemptId, turn, index, currentDeltaIndex),
          {
            assistantAttempt: turn,
            messageIndex: index,
            deltaIndex: currentDeltaIndex,
            delta: text,
            content: text,
          },
        );
      else
        queueEvent(
          type,
          `${eventIdentity}:assistant:${turn}:${index}:reasoning:${currentDeltaIndex}`,
          {
            assistantAttempt: turn,
            messageIndex: index,
            deltaIndex: currentDeltaIndex,
            delta: text,
          },
        );
    };

    const bufferDelta = (type: "assistant.delta" | "assistant.reasoning.delta", text: string) => {
      const index = Math.max(1, messageIndex);

      if (
        pendingDelta &&
        (pendingDelta.type !== type ||
          pendingDelta.assistantAttempt !== assistantAttempt ||
          pendingDelta.messageIndex !== index)
      )
        flushDelta();

      if (pendingDelta) pendingDelta.text += text;
      else
        pendingDelta = {
          type,
          assistantAttempt,
          messageIndex: index,
          text,
          timer: setTimeout(flushDelta, deltaFlushMs),
        };

      if (pendingDelta.text.length >= deltaFlushChars) flushDelta();
    };

    const remoteExec = async (
      command: string,
      toolCallId: string,
      toolSignal: AbortSignal | undefined,
      stdin?: string,
      access: "read" | "exclusive" = "exclusive",
      liveOutput = false,
      timeoutMs?: number,
    ): Promise<PiCommandDiagnostic> => {
      const effectiveSignal = toolSignal ? AbortSignal.any([toolSignal, signal]) : signal;

      if (config.git?.pending()) throw new Error("Not executed: waiting for Git approval.");

      if (config.questions?.pending()) throw new Error("Not executed: waiting for answers.");
      await config.git?.refreshAccess();

      // Only the user-facing shell tool publishes live output. Repository setup,
      // attachments, discovery and file tools stay silent.
      const progress: CommandProgressObserver | undefined = liveOutput
        ? (update) => {
            if (update.type === "unavailable") {
              queueEvent("tool.output", `${eventIdentity}:tool:${toolCallId}:live-unavailable`, {
                toolCallId,
                diagnostic: update.reason,
                partial: true,
              });

              return;
            }

            queueEvent(
              "tool.output",
              `${eventIdentity}:tool:${toolCallId}:live:${update.stream}:${update.offset}:${update.nextOffset}`,
              {
                toolCallId,
                incremental: true,
                commandId: update.commandId,
                callId: toolCallId,
                stream: update.stream,
                offset: update.offset,
                bytes: update.bytes,
                nextOffset: update.nextOffset,
                text: update.text,
              },
            );
          }
        : undefined;

      const request: CommandRequest = {
        command: `cd ${workspaceRoot} && ${config.git ? "export GIT_CONFIG_GLOBAL=/var/lib/cloud-swe/git.config && " : ""}${command}`,
        stdin,
        access,
      };

      if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;

      if (progress) request.progress = progress;

      let outcome: PiCommandDiagnostic;
      let coordinatorFailure: UnresolvedCommandError | undefined;

      try {
        effectiveSignal.throwIfAborted();
        const result = await config.sandbox.exec(workspace, request, effectiveSignal);
        outcome = normalizePiCommandResult(result, attempt.outputMaxBytes);
      } catch (error) {
        if (error instanceof UnresolvedCommandError) coordinatorFailure = error;
        outcome = transportFromThrownError(error, effectiveSignal, attempt.outputMaxBytes);
      }

      // Persist the complete bounded diagnostic before classifying the command
      // as a process result or a coordinator/transport failure.
      toolOutcomes.set(toolCallId, outcome);
      const outputIndex = toolOutputIndex++;

      const outputWrite = writeEvent(
        "tool.output",
        `${eventIdentity}:tool:${toolCallId}:output:${outputIndex}:${fingerprint(outcome.output)}`,
        {
          toolCallId,
          ...commandPayload(outcome),
        },
      );

      const isUnsettledTransport =
        outcome.kind === "transport-timeout" ||
        outcome.kind === "cancelled" ||
        outcome.kind === "unknown";

      const fatalError = isUnsettledTransport
        ? latchTransportError(outcome, coordinatorFailure)
        : undefined;

      await outputWrite;

      // A bounded output result is known-settled and may remain a tool error;
      // coordinator timeout/cancel/unknown outcomes are not. The latter must
      // remain fatal even if Pi swallows the tool exception and writes a final
      // textual answer.
      if (fatalError) throw fatalError;

      if (outcome.kind === "output-limit") throw new PiToolExecutionError(outcome);

      return outcome;
    };

    const bashTool: ToolDefinition<typeof bashParameters, unknown, unknown> = {
      name: "bash",
      label: "bash",
      promptSnippet: "Execute bash commands in /workspace (ls, rg, find, git, builds, tests)",
      promptGuidelines: [
        `bash commands time out after ${defaultCommandTimeoutSeconds} seconds; pass timeout (up to ${maxCommandTimeoutSeconds}) for longer builds and test suites`,
      ],
      description: `Execute a bash command in /workspace. Returns stdout, stderr and the exit code. Output is truncated to ${attempt.outputMaxBytes} bytes. Commands time out after ${defaultCommandTimeoutSeconds} seconds unless a timeout of up to ${maxCommandTimeoutSeconds} seconds is given.`,
      parameters: bashParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const outcome = await remoteExec(
          params.command,
          toolCallId,
          toolSignal,
          undefined,
          "exclusive",
          true,
          Math.min(params.timeout ?? defaultCommandTimeoutSeconds, maxCommandTimeoutSeconds) * 1000,
        );

        return textResult(
          `${outcome.output}\n[exit code ${outcome.statusCode}${outcome.outputTruncated ? "; output truncated" : ""}]`,
          outcome,
        );
      },
    };

    const readTool: ToolDefinition<typeof readParameters, unknown, unknown> = {
      name: "read",
      label: "read",
      promptSnippet: "Read file contents",
      promptGuidelines: ["Use read to examine files instead of cat or sed."],
      description:
        "Read a UTF-8 text file of at most 1 MiB. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
      parameters: readParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const outcome = await remoteExec(
          buildRemoteReadCommand(params.path, params.offset, params.limit),
          toolCallId,
          toolSignal,
          undefined,
          "read",
        );

        return textResult(
          `${outcome.output}\n[exit code ${outcome.statusCode}${outcome.outputTruncated ? "; output truncated" : ""}]`,
          outcome,
        );
      },
    };

    const writeTool: ToolDefinition<typeof writeParameters, unknown, unknown> = {
      name: "write",
      label: "write",
      promptSnippet: "Create or overwrite files",
      promptGuidelines: ["Use write only for new files or complete rewrites."],
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. Use only for new files or complete rewrites.",
      parameters: writeParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const outcome = await remoteExec(
          buildRemoteWriteCommand(params.path, commandStdoutMaxBytes(attempt.outputMaxBytes)),
          toolCallId,
          toolSignal,
          params.content,
        );

        if (outcome.kind !== "completed")
          return textResult(outcome.diagnostic || "The file was not written.", outcome);

        // Parsed through the same structured file-result path as edits, so the
        // created/replaced fact is the guest's, never inferred in the browser.
        const result = writeResultSchema.parse(JSON.parse(outcome.stdout));

        return textResult(
          result.change === "created"
            ? `Created ${result.path} (${result.bytes} bytes).`
            : `Wrote ${result.path} (${result.bytes} bytes).`,
          result,
        );
      },
    };

    const editTool: ToolDefinition<typeof editParameters, unknown, unknown> = {
      name: "edit",
      label: "edit",
      promptSnippet:
        "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
      promptGuidelines: [
        "Use edit for precise changes (edits[].oldText must match exactly)",
        "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
        "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
        "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
      ],
      description:
        "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. When changing multiple separate locations in one file, use one call with multiple entries in edits[]. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Keep oldText as small as possible while still unique. Returns a bounded unified diff.",
      parameters: editParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const outcome = await remoteExec(
          remoteFileCommand,
          toolCallId,
          toolSignal,
          JSON.stringify({
            operation: "edit",
            ...params,
            outputMaxBytes: commandStdoutMaxBytes(attempt.outputMaxBytes),
          }),
        );

        if (outcome.kind === "completed") {
          const result = editResultSchema.parse(JSON.parse(outcome.stdout));

          return textResult(JSON.stringify(result), result);
        }

        const failure = parseProjectToolFailure(outcome.stderr.trim());
        // The helper reports only its own validation messages; system errors are already generic.
        throw new Error(
          failure
            ? JSON.stringify(failure)
            : outcome.stderr.trim() || publicFailureMessage(undefined),
        );
      },
    };

    const tools: ToolDefinition[] = [
      bashTool,
      readTool,
      writeTool,
      editTool,
      ...(config.git?.tools ?? []),
      ...(config.questions?.tools ?? []),
      ...(config.webTools ?? []),
    ];

    const pendingWait = () => config.git?.pending() ?? config.questions?.pending();

    for (const tool of tools) {
      const execute = tool.execute;
      tool.execute = async (...args) => {
        const pending = pendingWait();

        if (pending)
          return {
            content: [
              {
                type: "text",
                text: config.git?.pending()
                  ? "Not executed: waiting for the pending Git approval."
                  : "Not executed: waiting for the pending answers.",
              },
            ],
            details: { skipped: true },
            terminate: true,
          };

        try {
          return await execute(...args);
        } catch (error) {
          if (error instanceof UnresolvedCommandError)
            throw latchTransportError(
              transportFromThrownError(error, signal, attempt.outputMaxBytes),
              error,
            );
          throw error;
        }
      };
    }

    const createSession = injectedSessionFactory ?? createAgentSession;

    const acquireSession = () =>
      createPiSession(
        createSession,
        {
          cwd: workspaceRoot,
          modelRuntime: runtime,
          model,
          thinkingLevel: config.thinkingLevel ?? "medium",
          noTools: "all",
          tools: tools.map((tool) => tool.name),
          customTools: tools,
          resourceLoader,
          sessionManager,
          settingsManager,
        },
        signal,
      );

    let subscribed = false;

    let unsubscribeRaw: (() => void) | undefined;

    let unsubscribe: (() => void) | undefined;

    const onAbort = (): void => {
      void abortSession();
    };

    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const created = yield* Effect.acquireRelease(piOperation(acquireSession), (created) =>
            Effect.promise(() => disposePiSession(created.session, config.logger)),
          );

          session = created.session;

          if ((config.git || config.questions) && session.agent) {
            const previous = session.agent.finishTurn;
            session.agent.finishTurn = async (turn, signal) =>
              pendingWait() ? { action: "end" } : ((await previous?.(turn, signal)) ?? undefined);
          }

          // The persistence consumer belongs to the acquired Pi session. Construct
          // it only after session creation succeeds so a rejected/cancelled factory
          // cannot leave a detached consumer fiber behind.
          writer = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new PiPersistenceWriter({
                  cleanupTimeoutMs: persistenceCleanupTimeoutMs,
                  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the first persistence failure for attempt-level precedence.
                  onFailure: (error) => {
                    Deferred.doneUnsafe(persistenceFailure, Effect.fail(error));

                    return abortSession();
                  },
                }),
            ),
            () => piOperation(() => completeWriter()).pipe(Effect.catch(() => Effect.void)),
          );
          completeWriter = async (options = {}) => {
            if (writerCleanupStarted) return;

            writerCleanupStarted = true;
            await writer.complete(options);
          };

          const captureSessionMetadata = (): PiSessionMetadata => {
            const header = sessionManager.getHeader();

            if (!header) throw new Error("Pi session is missing its header");

            return {
              sessionId: session.sessionId,
              provider: modelProvider,
              model: modelIdentifier,
              entries: [
                header,
                ...sessionManager.getEntries().map((entry) => {
                  if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
                  // Provider diagnostics and error bodies can contain request credentials.
                  const { diagnostics: _diagnostics, ...message } = entry.message;

                  return {
                    ...entry,
                    message: {
                      ...message,
                      errorMessage: message.errorMessage
                        ? publicFailureMessage(message.errorMessage)
                        : undefined,
                    },
                  };
                }),
              ],
              runId: input.runId,
              attemptId: attempt.attemptId,
              workspaceGeneration: attempt.workspaceGeneration,
              assistantAttempt,
            };
          };

          const awaitCommit = (acknowledgement: Promise<void>): Promise<void> =>
            Effect.runPromise(
              Effect.raceFirst(
                piOperation(() => acknowledgement, {
                  signal,
                  timeoutMs: persistenceCleanupTimeoutMs,
                }),
                Deferred.await(persistenceFailure),
              ),
            );

          const awaitPrompt = (): Promise<void> =>
            Effect.runPromise(
              Effect.raceFirst(
                piOperation(
                  () =>
                    session.prompt(
                      config.resources
                        ? expandRemoteSkill(input.prompt, config.resources)
                        : input.prompt,
                      {
                        expandPromptTemplates: false,
                        images: input.images?.length ? input.images : undefined,
                      },
                    ),
                  { signal },
                ),
                Deferred.await(persistenceFailure),
              ),
            );

          const persistSession = async (): Promise<PiPersistedSessionMetadata> => {
            try {
              const metadata = referenceCheckpointImages(
                captureSessionMetadata(),
                input.checkpointImages ?? [],
              );

              if (!config.checkpoint) return metadata;

              const estimatedSizeBytes = serializedPiCheckpointBytes(metadata);

              assertPiCheckpointSize(metadata, attempt.checkpointMaxBytes);

              // Admission must happen before decoding, sanitizing, or cloning the
              // complete transcript. This check is synchronous with the following
              // enqueue, so no other producer can race the retained-byte budget.
              writer.preflight(estimatedSizeBytes);

              const decoded = metadata;

              const normalizedMetadata: PiPersistedSessionMetadata = {
                ...decoded,
                runId: input.runId,
                attemptId: attempt.attemptId,
                workspaceGeneration: attempt.workspaceGeneration,
                assistantAttempt,
              };

              const sizeBytes = serializedPiCheckpointBytes(normalizedMetadata);

              assertPiCheckpointSize(normalizedMetadata, attempt.checkpointMaxBytes);

              // The shared Zod decoder returns a deep snapshot before the writer
              // waits behind earlier event writes. A later turn cannot enlarge it.
              const captured = normalizedMetadata;
              const capturedProposal = config.git?.pending();
              const capturedQuestionRequest = config.questions?.pending();

              await awaitCommit(
                writer.enqueue(
                  async () => {
                    await config.checkpoint?.(captured, capturedProposal, capturedQuestionRequest);
                  },
                  {
                    kind: "checkpoint",
                    sizeBytes,
                  },
                ),
              );

              return normalizedMetadata;
            } catch (error) {
              if (!writer.failed && !signal.aborted) writer.fail(error);

              throw error;
            }
          };

          const queueCheckpoint = (): void => {
            void persistSession().catch(() => undefined);
          };

          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Rethrow the original failure after draining persistence and aborting the SDK session.
          const throwAfterDrain = async (fallbackError: unknown): Promise<never> => {
            const deadline = Date.now() + persistenceCleanupTimeoutMs;

            // Stop producer admission before waiting on SDK or persistence
            // cleanup. Late SDK callbacks are ignored by the subscription guard.
            unsubscribe?.();
            writer.close();

            try {
              await Effect.runPromise(
                piOperation(abortSession, { timeoutMs: Math.max(1, deadline - Date.now()) }),
              );
            } catch {
              // Cleanup is bounded and secondary. The persistence failure, if any,
              // remains authoritative below.
            }

            try {
              await completeWriter({ timeoutMs: Math.max(1, deadline - Date.now()) });
            } catch (error) {
              if (writer.failure?.error !== undefined) throw writer.failure.error;

              // A producer failure remains authoritative over a secondary cleanup
              // timeout or cancellation.
              if (latchedTransportError) throw latchedTransportError;
              throw fallbackError ?? error;
            }

            if (writer.failure?.error !== undefined) throw writer.failure.error;

            if (latchedTransportError) throw latchedTransportError;
            throw fallbackError;
          };

          yield* Effect.acquireRelease(
            Effect.try({
              try: () => {
                subscribed = true;
                unsubscribe = session.subscribe((event: AgentSessionEvent) => {
                  if (!subscribed) return;

                  const isDelta =
                    event.type === "message_update" &&
                    (event.assistantMessageEvent.type === "text_delta" ||
                      event.assistantMessageEvent.type === "thinking_delta");

                  // Every other event is ordered after the text streamed before it.
                  if (!isDelta) flushDelta();

                  if (event.type === "agent_start") {
                    assistantAttempt += 1;
                    messageIndex = 0;
                  }

                  // A new assistant message inside the turn opens its own
                  // boundary. Only the same (turn, message) identity supersedes
                  // earlier partial text; a later message never erases earlier
                  // commentary or the tool calls between them.
                  if (event.type === "message_start" && event.message.role === "assistant") {
                    messageIndex += 1;
                    reasoningContentIndex = undefined;
                    queueEvent(
                      "assistant.started",
                      assistantStartedDedupeKey(
                        input.runId,
                        attempt.attemptId,
                        assistantAttempt,
                        messageIndex,
                      ),
                      { assistantAttempt, messageIndex },
                    );
                  }

                  // The completed message is authoritative for that boundary; the
                  // streamed deltas remain available for the live preview.
                  if (event.type === "message_end" && event.message.role === "assistant") {
                    const message = event.message;

                    const content = message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("");

                    const bounded = boundedUtf8(content, attempt.outputMaxBytes);

                    // Only the readable reasoning text; the signature is opaque provider state.
                    const reasoning = boundedUtf8(
                      message.content
                        .filter((part) => part.type === "thinking")
                        .map((part) => part.thinking.trim())
                        .filter(Boolean)
                        .join("\n\n"),
                      attempt.outputMaxBytes,
                    );

                    const payload: JsonObject = {
                      assistantAttempt,
                      messageIndex: Math.max(1, messageIndex),
                      content: bounded.text,
                      contentTruncated: bounded.truncated,
                      stopReason:
                        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SDK stop reasons are an open provider string.
                        typeof message.stopReason === "string" ? message.stopReason : undefined,
                    };

                    if (reasoning.text) {
                      payload.reasoning = reasoning.text;
                      payload.reasoningTruncated = reasoning.truncated;
                    }

                    queueEvent(
                      "assistant.message",
                      `${eventIdentity}:assistant:${assistantAttempt}:${Math.max(1, messageIndex)}:message`,
                      payload,
                    );
                  }

                  if (
                    event.type === "message_update" &&
                    event.assistantMessageEvent.type === "text_delta"
                  ) {
                    bufferDelta("assistant.delta", event.assistantMessageEvent.delta);
                  }

                  if (
                    event.type === "message_update" &&
                    event.assistantMessageEvent.type === "thinking_delta"
                  ) {
                    const { contentIndex, delta } = event.assistantMessageEvent;

                    const separator =
                      reasoningContentIndex !== undefined && reasoningContentIndex !== contentIndex
                        ? "\n\n"
                        : "";

                    reasoningContentIndex = contentIndex;
                    bufferDelta("assistant.reasoning.delta", separator + delta);
                  }

                  if (event.type === "tool_execution_start")
                    queueEvent(
                      "tool.started",
                      `${eventIdentity}:tool:${event.toolCallId}:started`,
                      {
                        toolCallId: event.toolCallId,
                        name: event.toolName,
                        args: jsonValueSchema.parse(
                          Match.value(event.toolName).pipe(
                            Match.when("edit", () => boundedEditArgs(event.args)),
                            Match.when("write", () => boundedWriteArgs(event.args)),
                            Match.orElse(() => event.args),
                          ),
                        ),
                      },
                    );

                  if (event.type === "tool_execution_update") {
                    const partial = boundedValue(event.partialResult, attempt.outputMaxBytes);
                    const outputIndex = toolOutputIndex++;
                    queueEvent(
                      "tool.output",
                      `${eventIdentity}:tool:${event.toolCallId}:partial:${outputIndex}:${fingerprint(partial.text)}`,
                      {
                        toolCallId: event.toolCallId,
                        output: partial.text,
                        diagnostic: partial.text,
                        outputTruncated: partial.truncated,
                        truncated: partial.truncated,
                        partial: true,
                      },
                    );
                  }

                  if (event.type === "tool_execution_end") {
                    const outcome = toolOutcomes.get(event.toolCallId);
                    const fallback = boundedValue(event.result, attempt.outputMaxBytes);
                    const structured = structuredToolResult(event.toolName, event.result);

                    queueEvent(
                      "tool.completed",
                      `${eventIdentity}:tool:${event.toolCallId}:completed`,
                      {
                        toolCallId: event.toolCallId,
                        name: event.toolName,
                        isError: event.isError,
                        result: structured ?? undefined,
                        ...(outcome
                          ? commandPayload(outcome)
                          : {
                              kind: event.isError ? "unknown" : "completed",
                              stdout: "",
                              stderr: "",
                              output: event.isError
                                ? publicFailureMessage(fallback.text)
                                : fallback.text,
                              diagnostic: event.isError
                                ? publicFailureMessage(fallback.text)
                                : fallback.text,
                              statusCode: null,
                              outputTruncated: fallback.truncated,
                            }),
                      },
                    );
                  }

                  // Pi appends all message entries before turn_end. A turn boundary is the
                  // minimum durable session save; entry_appended and agent_end are not save
                  // triggers, avoiding a full-array rewrite for every transcript entry.
                  if (event.type === "turn_end") {
                    queueCheckpoint();

                    if (pendingWait() && !session.agent) void abortSession();
                  }
                });
                unsubscribeRaw = unsubscribe;
                unsubscribe = () => {
                  if (!subscribed) return;

                  flushDelta();
                  subscribed = false;
                  unsubscribeRaw?.();
                };

                signal.addEventListener("abort", onAbort, { once: true });
              },
              catch: (error) => error,
            }),
            () =>
              Effect.sync(() => {
                signal.removeEventListener("abort", onAbort);
                unsubscribe?.();
              }),
          );

          return yield* piOperation(async () => {
            try {
              await persistSession();
              signal.throwIfAborted();
              await awaitPrompt();
              flushDelta();
              signal.throwIfAborted();

              if (latchedTransportError) await throwAfterDrain(latchedTransportError);
              await writer.drain({ timeoutMs: persistenceCleanupTimeoutMs });

              if (latchedTransportError) await throwAfterDrain(latchedTransportError);

              const approval = config.git?.pending();
              const questionRequest = config.questions?.pending();

              if (approval || questionRequest) {
                unsubscribe?.();
                const metadata = await persistSession();
                await completeWriter({ timeoutMs: persistenceCleanupTimeoutMs });

                return {
                  text: approval ? "Waiting for Git approval." : "Waiting for answers.",
                  session: metadata,
                  approval,
                  questionRequest,
                };
              }

              const assistant = [...session.messages]
                .reverse()
                .find((message) => message.role === "assistant");

              if (!assistant) throw new Error("Pi completed without an assistant response");

              if (assistant.stopReason === "error" || assistant.stopReason === "aborted")
                throw new ThreadStoreError(
                  "MODEL_SERVICE_FAILED",
                  "The model service could not complete this task.",
                );
              const text = textFromMessages(session);

              if (!text.trim())
                throw new Error("Pi completed without a textual assistant response");

              unsubscribe?.();
              const metadata = await persistSession();
              await completeWriter({ timeoutMs: persistenceCleanupTimeoutMs });

              return { text, session: metadata };
            } catch (error) {
              await throwAfterDrain(error);
              // throwAfterDrain always throws; rethrow to satisfy the executor's
              // PiExecutorOutput return contract on every code path.
              throw error;
            }
          });
        }),
      ),
    );
  };
}
