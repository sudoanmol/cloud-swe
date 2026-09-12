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
} from "./remote-files.js";

export { workspacePath, buildRemoteReadCommand, buildRemoteWriteCommand } from "./remote-files.js";

import { Type } from "typebox";
import { z } from "zod";
import { Effect, Exit, Scope } from "effect";
import type { Logger } from "pino";
import { decodePiSessionCheckpoint } from "@cloud-swe/db/checkpoint";
import { jsonValueSchema, type JsonObject } from "@cloud-swe/db/json";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";
import { publicFailureMessage } from "@cloud-swe/db/public-failure";
import {
  PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS,
  PiPersistenceCleanupError,
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate SDK tool arguments before projecting bounded event metadata.
function boundedEditArgs(args: unknown) {
  const parsed = z
    .object({
      path: z.string(),
      oldText: z.string(),
      newText: z.string(),
      replaceAll: z.boolean().optional(),
    })
    .safeParse(args);

  if (!parsed.success) return { invalid: true };

  return {
    path: parsed.data.path.slice(0, 4096),
    oldTextBytes: Buffer.byteLength(parsed.data.oldText),
    newTextBytes: Buffer.byteLength(parsed.data.newText),
    replaceAll: parsed.data.replaceAll ?? false,
  };
}

const execParameters = Type.Object({ command: Type.String() });

const readParameters = Type.Object({ path: Type.String() });

const writeParameters = Type.Object({ path: Type.String(), content: Type.String() });

const editParameters = Type.Object({
  path: Type.String(),
  oldText: Type.String({ minLength: 1 }),
  newText: Type.String(),
  replaceAll: Type.Optional(Type.Boolean()),
});

export const PI_TOOL_NAMES = ["remote_exec", "remote_read", "remote_write", "remote_edit"] as const;

export type PiToolName = (typeof PI_TOOL_NAMES)[number];

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export type PiEventType =
  | "assistant.started"
  | "assistant.delta"
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
  resources?: RemoteResources;
  sandbox: Pick<SandboxProvider, "exec">;
  workspace: WorkspaceRef;
  /** Provider selected by worker configuration. */
  piProvider?: string;
  /** Model selected by worker configuration. */
  piModel?: string;
  thinkingLevel?: PiThinkingLevel;
  /** The key is installed for piProvider, never for a hard-coded provider. */
  aiGatewayApiKey?: string;
  /** Worker-level default for the shared stdout/stderr byte limit. */
  outputMaxBytes?: number;
  /** Worker-level default for the serialized resumable-session checkpoint size. */
  checkpointMaxBytes?: number;
  /** Cleanup budget for persistence acknowledgements and session aborts. */
  persistenceCleanupTimeoutMs?: number;
  emit: (event: PiEvent) => Awaitable<void>;
  /** Persists the resumable session checkpoint, not the completion checkpoint. */
  checkpoint?: (metadata: PiSessionMetadata) => Awaitable<void>;
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

export interface PiExecutorOutput {
  text: string;
  session: PiSessionMetadata;
}

export type PiCommandOutcomeKind =
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

function boundedUtf8(value: string, maxBytes: number): BoundedText {
  const bytes = Buffer.from(value, "utf8");

  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };

  let end = maxBytes;

  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;

  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
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
): string {
  return `${piAttemptEventIdentity(runId, attemptId)}:assistant:${assistantAttempt}:started`;
}

export function assistantDeltaDedupeKey(
  runId: string,
  attemptId: string,
  assistantAttempt: number,
  deltaIndex: number,
): string {
  return `${piAttemptEventIdentity(runId, attemptId)}:assistant:${assistantAttempt}:delta:${deltaIndex}`;
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
    error: boundedError || undefined,
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
>;

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
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Pi session cleanup timed out")),
      PI_WRITER_DEFAULT_CLEANUP_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([Promise.resolve().then(() => session.dispose()), timeout]);
  } catch {
    // Cleanup is secondary to the attempt result. Avoid logging SDK error text,
    // which may contain provider credentials or response bodies.
    logger?.warn({ resource: "pi-session" }, "Pi session cleanup failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

type ModelRuntimeOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>;

type CredentialStore = NonNullable<ModelRuntimeOptions["credentials"]>;

function createInMemoryCredentialStore(): CredentialStore {
  return {
    read: async () => undefined,
    list: async () => [],
    modify: async (_providerId, update) => update(undefined),
    delete: async () => undefined,
  };
}

/**
 * Synchronous getters use only a captured remote snapshot. Worker-global
 * resources, native skill expansion and JavaScript extensions stay disabled.
 */
export function createPiResourceLoader(resources?: RemoteResources): ResourceLoader {
  const extensionRuntime = createExtensionRuntime();

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: resources?.instructions ?? [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => (resources?.catalog ? [resources.catalog] : []),
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate persisted checkpoint metadata at the read boundary.
export function parsePiSessionMetadata(value: unknown): PiSessionMetadata | undefined {
  try {
    return decodePiSessionCheckpoint(value);
  } catch {
    return undefined;
  }
}

/** Extract resumable Pi session metadata from a checkpoint content object. */
export const piSessionMetadataFromContent = parsePiSessionMetadata;

export function resolvePiAttemptOptions(
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

export function serializedPiCheckpointBytes(metadata: PiSessionMetadata): number {
  try {
    const payload = { version: 1, kind: "pi", ...metadata };

    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    throw new PiCheckpointSerializationError();
  }
}

export function assertPiCheckpointSize(metadata: PiSessionMetadata, limitBytes: number): void {
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
    const apiKey = config.aiGatewayApiKey;
    let runtime: ModelRuntime | undefined;
    let model: CreateAgentSessionOptions["model"];

    if (!injectedSessionFactory) {
      if (!provider) throw new Error("Pi provider is required");

      if (!modelId) throw new Error("Pi model is required");

      if (!apiKey) throw new Error(`API key is required for configured Pi provider ${provider}`);

      runtime = await ModelRuntime.create({
        credentials: createInMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      await runtime.setRuntimeApiKey(provider, apiKey);
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

    const resourceLoader = createPiResourceLoader(config.resources);
    const editResults = new Map<string, z.infer<typeof editResultSchema>>();
    const toolOutcomes = new Map<string, PiCommandDiagnostic>();
    let toolOutputIndex = 0;
    let deltaIndex = 0;
    let assistantAttempt = 0;

    let session: PiSessionLike;
    let writer: PiPersistenceWriter;
    let writerCleanupStarted = false;

    let completeWriter: (options?: PiWriterCompletionOptions) => Promise<void>;

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the first persistence failure for attempt-level precedence.
    let rejectPersistenceFailure: (error: unknown) => void = () => undefined;

    const persistenceFailure = new Promise<never>((_, reject) => {
      rejectPersistenceFailure = reject;
    });

    void persistenceFailure.catch(() => undefined);
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

    let latchedTransportError: PiToolExecutionError | undefined;

    const latchTransportError = (outcome: PiCommandDiagnostic): PiToolExecutionError => {
      if (!latchedTransportError) {
        latchedTransportError = new PiToolExecutionError(outcome);
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

    const remoteExec = async (
      command: string,
      toolCallId: string,
      toolSignal: AbortSignal | undefined,
      stdin?: string,
    ): Promise<PiCommandDiagnostic> => {
      const effectiveSignal = toolSignal ?? signal;
      const request: CommandRequest = { command: `cd ${workspaceRoot} && ${command}`, stdin };
      let outcome: PiCommandDiagnostic;

      try {
        effectiveSignal.throwIfAborted();
        const result = await config.sandbox.exec(workspace, request, effectiveSignal);
        outcome = normalizePiCommandResult(result, attempt.outputMaxBytes);
      } catch (error) {
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

      const fatalError = isUnsettledTransport ? latchTransportError(outcome) : undefined;
      await outputWrite;

      // A bounded output result is known-settled and may remain a tool error;
      // coordinator timeout/cancel/unknown outcomes are not. The latter must
      // remain fatal even if Pi swallows the tool exception and writes a final
      // textual answer.
      if (fatalError) throw fatalError;

      if (outcome.kind === "output-limit") throw new PiToolExecutionError(outcome);

      return outcome;
    };

    const execTool: ToolDefinition<typeof execParameters, unknown, unknown> = {
      name: "remote_exec",
      label: "Remote exec",
      description: "Execute a shell command in the remote workspace.",
      parameters: execParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const outcome = await remoteExec(params.command, toolCallId, toolSignal);

        return textResult(outcome.diagnostic, outcome);
      },
    };

    const readTool: ToolDefinition<typeof readParameters, unknown, unknown> = {
      name: "remote_read",
      label: "Remote read",
      description: "Read a file from the remote workspace.",
      parameters: readParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const outcome = await remoteExec(
          buildRemoteReadCommand(params.path),
          toolCallId,
          toolSignal,
        );

        return textResult(outcome.diagnostic, outcome);
      },
    };

    const writeTool: ToolDefinition<typeof writeParameters, unknown, unknown> = {
      name: "remote_write",
      label: "Remote write",
      description: "Write a file in the remote workspace.",
      parameters: writeParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const outcome = await remoteExec(
          buildRemoteWriteCommand(params.path),
          toolCallId,
          toolSignal,
          params.content,
        );

        return textResult(outcome.diagnostic || "Wrote file successfully.", outcome);
      },
    };

    const editTool: ToolDefinition<typeof editParameters, unknown, unknown> = {
      name: "remote_edit",
      label: "Remote edit",
      description:
        "Replace an exact literal match in a UTF-8 workspace file. Use replaceAll for multiple matches. Returns a bounded unified diff and hashes.",
      parameters: editParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const outcome = await remoteExec(
          remoteFileCommand,
          toolCallId,
          toolSignal,
          JSON.stringify({ operation: "edit", ...params, outputMaxBytes: attempt.outputMaxBytes }),
        );

        if (outcome.kind === "completed") {
          const result = editResultSchema.parse(JSON.parse(outcome.stdout));
          editResults.set(toolCallId, result);

          return textResult(JSON.stringify(result), result);
        }

        throw new Error(outcome.diagnostic);
      },
    };

    const tools = [execTool, readTool, writeTool, editTool];

    const createSession = injectedSessionFactory ?? createAgentSession;

    const created = await createPiSession(
      createSession,
      {
        cwd: workspaceRoot,
        modelRuntime: runtime,
        model,
        thinkingLevel: config.thinkingLevel ?? "medium",
        noTools: "all",
        tools: [...PI_TOOL_NAMES],
        customTools: tools,
        resourceLoader,
        sessionManager,
        settingsManager,
      },
      signal,
    );

    session = created.session;
    let subscribed = false;

    let unsubscribeRaw: (() => void) | undefined;

    let unsubscribe: (() => void) | undefined;

    const onAbort = (): void => {
      void abortSession();
    };

    let attemptScope: ReturnType<typeof Scope.makeUnsafe> | undefined;

    try {
      const scope = Scope.makeUnsafe("sequential");
      attemptScope = scope;
      Effect.runSync(
        Scope.addFinalizer(
          scope,
          Effect.tryPromise({
            try: () => disposePiSession(session, config.logger),
            catch: () => undefined,
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.asVoid,
          ),
        ),
      );

      // The persistence consumer belongs to the acquired Pi session. Construct
      // it only after session creation succeeds so a rejected/cancelled factory
      // cannot leave a detached consumer fiber behind.
      writer = new PiPersistenceWriter({
        cleanupTimeoutMs: persistenceCleanupTimeoutMs,
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the first persistence failure for attempt-level precedence.
        onFailure: (error) => {
          rejectPersistenceFailure(error);

          return abortSession();
        },
      });
      completeWriter = async (options = {}) => {
        if (writerCleanupStarted) return;

        writerCleanupStarted = true;
        await writer.complete(options);
      };

      Effect.runSync(
        Scope.addFinalizer(
          scope,
          Effect.tryPromise({
            try: () => completeWriter(),
            catch: () => undefined,
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.asVoid,
          ),
        ),
      );

      const captureSessionMetadata = (): PiSessionMetadata => {
        const header = sessionManager.getHeader();

        if (!header) throw new Error("Pi session is missing its header");

        return {
          sessionId: session.sessionId,
          provider: modelProvider,
          model: modelIdentifier,
          entries: [header, ...sessionManager.getEntries()],
          runId: input.runId,
          attemptId: attempt.attemptId,
          workspaceGeneration: attempt.workspaceGeneration,
          assistantAttempt,
        };
      };

      const awaitCommit = async (acknowledgement: Promise<void>): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        let onAbort: (() => void) | undefined;

        const cancellation = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new PiPersistenceCleanupError("cancelled"));

          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });

        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PiPersistenceCleanupError("timeout")),
            persistenceCleanupTimeoutMs,
          );
        });

        try {
          await Promise.race([acknowledgement, cancellation, timeout, persistenceFailure]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);

          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      };

      const awaitPrompt = async (): Promise<void> => {
        let onPromptAbort: (() => void) | undefined;

        const cancellation = new Promise<never>((_, reject) => {
          onPromptAbort = () => reject(signal.reason ?? new PiPersistenceCleanupError("cancelled"));

          if (signal.aborted) onPromptAbort();
          else signal.addEventListener("abort", onPromptAbort, { once: true });
        });

        try {
          await Promise.race([
            session.prompt(
              config.resources ? expandRemoteSkill(input.prompt, config.resources) : input.prompt,
              { expandPromptTemplates: false },
            ),
            cancellation,
            persistenceFailure,
          ]);
        } finally {
          if (onPromptAbort) signal.removeEventListener("abort", onPromptAbort);
        }
      };

      const persistSession = async (): Promise<PiSessionMetadata> => {
        try {
          const metadata = captureSessionMetadata();

          if (!config.checkpoint) return metadata;

          const estimatedSizeBytes = serializedPiCheckpointBytes(metadata);

          if (estimatedSizeBytes > attempt.checkpointMaxBytes)
            throw new PiCheckpointLimitError(estimatedSizeBytes, attempt.checkpointMaxBytes);

          // Admission must happen before decoding, sanitizing, or cloning the
          // complete transcript. This check is synchronous with the following
          // enqueue, so no other producer can race the retained-byte budget.
          writer.preflight(estimatedSizeBytes);

          const decoded = decodePiSessionCheckpoint(metadata);

          const normalizedMetadata: PiSessionMetadata = {
            ...decoded,
            runId: input.runId,
            attemptId: attempt.attemptId,
            workspaceGeneration: attempt.workspaceGeneration,
            assistantAttempt,
          };

          const sizeBytes = serializedPiCheckpointBytes(normalizedMetadata);

          if (sizeBytes > attempt.checkpointMaxBytes)
            throw new PiCheckpointLimitError(sizeBytes, attempt.checkpointMaxBytes);

          // The shared Zod decoder returns a deep snapshot before the writer
          // waits behind earlier event writes. A later turn cannot enlarge it.
          const captured = normalizedMetadata;

          await awaitCommit(
            writer.enqueue(
              async () => {
                await config.checkpoint?.(captured);
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
          const remaining = Math.max(1, deadline - Date.now());
          let timer: ReturnType<typeof setTimeout> | undefined;

          try {
            await Promise.race([
              abortSession(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Pi session abort timed out")),
                  remaining,
                );
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
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

      signal.addEventListener("abort", onAbort, { once: true });

      subscribed = true;
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (!subscribed) return;

        if (event.type === "agent_start") {
          assistantAttempt += 1;
          queueEvent(
            "assistant.started",
            assistantStartedDedupeKey(input.runId, attempt.attemptId, assistantAttempt),
            { assistantAttempt },
          );
        }

        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          const currentDeltaIndex = deltaIndex++;
          queueEvent(
            "assistant.delta",
            assistantDeltaDedupeKey(
              input.runId,
              attempt.attemptId,
              assistantAttempt,
              currentDeltaIndex,
            ),
            {
              assistantAttempt,
              deltaIndex: currentDeltaIndex,
              delta: event.assistantMessageEvent.delta,
              content: event.assistantMessageEvent.delta,
            },
          );
        }

        if (event.type === "tool_execution_start")
          queueEvent("tool.started", `${eventIdentity}:tool:${event.toolCallId}:started`, {
            toolCallId: event.toolCallId,
            name: event.toolName,
            args: jsonValueSchema.parse(
              event.toolName === "remote_edit" ? boundedEditArgs(event.args) : event.args,
            ),
          });

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
          queueEvent("tool.completed", `${eventIdentity}:tool:${event.toolCallId}:completed`, {
            toolCallId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            result: editResults.get(event.toolCallId),
            ...(outcome
              ? commandPayload(outcome)
              : {
                  kind: event.isError ? "unknown" : "completed",
                  stdout: "",
                  stderr: "",
                  output: event.isError ? publicFailureMessage(fallback.text) : fallback.text,
                  diagnostic: event.isError ? publicFailureMessage(fallback.text) : fallback.text,
                  statusCode: null,
                  outputTruncated: fallback.truncated,
                }),
          });
        }

        // Pi appends all message entries before turn_end. A turn boundary is the
        // minimum durable session save; entry_appended and agent_end are not save
        // triggers, avoiding a full-array rewrite for every transcript entry.
        if (event.type === "turn_end") queueCheckpoint();
      });
      unsubscribeRaw = unsubscribe;
      unsubscribe = () => {
        if (!subscribed) return;

        subscribed = false;
        unsubscribeRaw?.();
      };

      Effect.runSync(
        Scope.addFinalizer(
          scope,
          Effect.sync(() => unsubscribe?.()),
        ),
      );

      try {
        await persistSession();
        signal.throwIfAborted();
        await awaitPrompt();
        signal.throwIfAborted();

        if (latchedTransportError) await throwAfterDrain(latchedTransportError);
        await writer.drain({ timeoutMs: persistenceCleanupTimeoutMs });

        if (latchedTransportError) await throwAfterDrain(latchedTransportError);

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

        if (!text.trim()) throw new Error("Pi completed without a textual assistant response");

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
    } finally {
      signal.removeEventListener("abort", onAbort);

      unsubscribe?.();

      if (attemptScope)
        try {
          await Effect.runPromise(Scope.close(attemptScope, Exit.void));
        } catch {
          // Cleanup failures are secondary to the attempt result.
        }
    }
  };
}
