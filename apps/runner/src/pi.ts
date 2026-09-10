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
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Type } from "typebox";
import { OrderedPiWriter, type Awaitable } from "./pi-writer.js";
import {
  isProcessResult,
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

const execParameters = Type.Object({ command: Type.String() });
const readParameters = Type.Object({ path: Type.String() });
const writeParameters = Type.Object({ path: Type.String(), content: Type.String() });

export const PI_TOOL_NAMES = ["remote_exec", "remote_read", "remote_write"] as const;
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
  payload: Record<string, unknown>;
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
  sandbox: SandboxProvider;
  workspace: WorkspaceRef;
  /** Provider selected by worker configuration. */
  piProvider?: string;
  /** Model selected by worker configuration. */
  piModel?: string;
  thinkingLevel?: PiThinkingLevel;
  /** The key is installed for piProvider, never for a hard-coded provider. */
  aiGatewayApiKey?: string;
  /** Preferred provider-neutral name for the worker's model key. */
  piApiKey?: string;
  /** Optional limits/configuration retained on the executor for callers that reuse it. */
  outputMaxBytes?: number;
  commandOutputMaxBytes?: number;
  checkpointMaxBytes?: number;
  attemptId?: string;
  workspaceGeneration?: number;
  emit: (event: PiEvent) => Awaitable<void>;
  /** Persists the resumable session checkpoint, not the completion checkpoint. */
  checkpoint?: (metadata: PiSessionMetadata) => Awaitable<void>;
}

export interface PiExecutorInput {
  prompt: string;
  signal?: AbortSignal;
  runId: string;
  /** New activity attempt identity. Required by the activity owner. */
  attemptId?: string;
  /** Workspace generation observed by the activity owner. */
  workspaceGeneration?: number;
  /** Per-attempt limit overrides supplied by the activity owner. */
  outputMaxBytes?: number;
  commandOutputMaxBytes?: number;
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
  /** Alias retained for consumers that call this field an outcome. */
  outcome: PiCommandOutcomeKind;
  stdout: string;
  stderr: string;
  output: string;
  diagnostic: string;
  statusCode: number | null;
  outputTruncated: boolean;
  truncated: boolean;
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

function boundedValue(value: unknown, maxBytes: number): BoundedText {
  if (typeof value === "string") return boundedUtf8(value, maxBytes);
  try {
    const serialized = JSON.stringify(value);
    return boundedUtf8(serialized ?? String(value), maxBytes);
  } catch {
    return boundedUtf8("[unserializable tool result]", maxBytes);
  }
}

function fingerprint(value: unknown): string {
  const serialized = boundedValue(value, 64 * 1024).text;
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function workspacePath(path: string): string {
  if (path.includes("\0")) throw new Error("Path contains a NUL byte");
  const normalized = posix.resolve(path.startsWith("/") ? path : posix.join(workspaceRoot, path));
  if (normalized !== workspaceRoot && !normalized.startsWith(`${workspaceRoot}/`)) {
    throw new Error("Path must remain inside /workspace");
  }
  return normalized;
}

export function buildRemoteReadCommand(path: string): string {
  return `cat -- ${quoteShell(workspacePath(path))}`;
}

export function buildRemoteWriteCommand(path: string): string {
  const normalized = workspacePath(path);
  return `mkdir -p -- "$(dirname -- ${quoteShell(normalized)})" && cat > ${quoteShell(normalized)}`;
}

export function piAttemptEventIdentity(runId: string, attemptId: string): string {
  return `run:${runId}:attempt:${attemptId}`;
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
): { stdout: string; stderr: string; output: string; truncated: boolean } {
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
    outcome: kind,
    stdout: streams.stdout,
    stderr: streams.stderr,
    output: streams.output,
    diagnostic,
    statusCode,
    outputTruncated: streams.truncated,
    truncated: streams.truncated,
    ...(boundedError ? { error: boundedError } : {}),
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
    transport.error,
    limit,
  );
}

/** Exported name for callers that prefer a formatter-oriented API. */
export const formatPiCommandDiagnostic = normalizePiCommandResult;

/**
 * Return a bounded command diagnostic. Unlike the old helper, this never
 * throws merely because the guest process returned a non-zero status.
 */
export function commandOutput(result: CommandResult, maxBytes = defaultOutputMaxBytes): string {
  return normalizePiCommandResult(result, maxBytes).diagnostic;
}

function transportFromThrownError(
  error: unknown,
  signal: AbortSignal,
  maxBytes: number,
): PiCommandDiagnostic {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "sandbox command failed";
  const lower = message.toLowerCase();
  let kind: PiCommandOutcomeKind = "unknown";
  if (signal.aborted || lower.includes("cancel") || lower.includes("abort")) kind = "cancelled";
  else if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline"))
    kind = "transport-timeout";
  else if (lower.includes("output") && (lower.includes("limit") || lower.includes("exceed")))
    kind = "output-limit";
  return normalizedDiagnostic(kind, "", "", null, kind === "output-limit", message, maxBytes);
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
 * Resource loading for a worker Pi session is deliberately empty. In
 * particular, it does not inspect the worker cwd, ~/.pi, project skills, or
 * project extensions.
 */
export function createPiResourceLoader(): ResourceLoader {
  const extensionRuntime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

export function resolvePiAttemptOptions(
  config: PiExecutorConfig,
  input: PiExecutorInput,
  workspace: WorkspaceRef,
): PiAttemptOptions {
  const attemptId = input.attemptId ?? config.attemptId ?? `run:${input.runId}`;
  if (!attemptId) throw new Error("Pi attemptId is required");
  return {
    attemptId,
    workspaceGeneration:
      input.workspaceGeneration ?? config.workspaceGeneration ?? workspace.generation,
    outputMaxBytes: positiveInteger(
      input.outputMaxBytes ??
        input.commandOutputMaxBytes ??
        config.outputMaxBytes ??
        config.commandOutputMaxBytes,
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

function commandPayload(outcome: PiCommandDiagnostic): Record<string, unknown> {
  return {
    kind: outcome.kind,
    outcome: outcome.outcome,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    output: outcome.output,
    diagnostic: outcome.diagnostic,
    statusCode: outcome.statusCode,
    outputTruncated: outcome.outputTruncated,
    truncated: outcome.truncated,
    ...(outcome.error ? { error: outcome.error } : {}),
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
    const injectedSessionFactory = dependencies.createAgentSession;
    const provider = config.piProvider?.trim();
    const modelId = config.piModel?.trim();
    const apiKey = config.piApiKey ?? config.aiGatewayApiKey;
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
    const resourceLoader = createPiResourceLoader();
    const toolOutcomes = new Map<string, PiCommandDiagnostic>();
    let toolOutputIndex = 0;
    let deltaIndex = 0;
    let assistantAttempt = 0;

    let session: PiSessionLike;
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
    const writer = new OrderedPiWriter({
      onFailure: () => abortSession(),
    });

    const eventIdentity = piAttemptEventIdentity(input.runId, attempt.attemptId);
    const withMetadata = (payload: Record<string, unknown>): Record<string, unknown> => ({
      ...payload,
      runId: input.runId,
      attemptId: attempt.attemptId,
    });
    const writeEvent = (
      type: PiEventType,
      dedupeKey: string,
      payload: Record<string, unknown>,
    ): Promise<void> =>
      writer.enqueue(() =>
        config.emit({
          type,
          dedupeKey,
          payload: withMetadata(payload),
        }),
      );
    const queueEvent = (
      type: PiEventType,
      dedupeKey: string,
      payload: Record<string, unknown>,
    ): void => {
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
    const tools = [execTool, readTool, writeTool];

    const createSession = injectedSessionFactory ?? createAgentSession;
    const created = await createSession({
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
    });
    session = created.session;

    const sessionMetadata = (): PiSessionMetadata => {
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
    const persistSession = async (metadata = sessionMetadata()): Promise<void> => {
      if (!config.checkpoint) return;
      // Capture the turn snapshot before the writer waits behind earlier event
      // writes. A later turn must not accidentally enlarge this checkpoint.
      await writer.enqueue(async () => {
        assertPiCheckpointSize(metadata, attempt.checkpointMaxBytes);
        await config.checkpoint?.(metadata);
      });
    };
    const queueCheckpoint = (): void => {
      void persistSession().catch(() => undefined);
    };
    const throwAfterDrain = async (fallbackError: unknown): Promise<never> => {
      await abortSession();
      await writer.drain();
      if (latchedTransportError) throw latchedTransportError;
      throw fallbackError;
    };
    const onAbort = (): void => {
      void abortSession();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
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
          args: event.args,
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
          ...(outcome
            ? commandPayload(outcome)
            : {
                kind: event.isError ? "unknown" : "completed",
                outcome: event.isError ? "unknown" : "completed",
                stdout: "",
                stderr: "",
                output: fallback.text,
                diagnostic: fallback.text,
                statusCode: null,
                outputTruncated: fallback.truncated,
                truncated: fallback.truncated,
              }),
        });
      }
      // Pi appends all message entries before turn_end. A turn boundary is the
      // minimum durable session save; entry_appended and agent_end are not save
      // triggers, avoiding a full-array rewrite for every transcript entry.
      if (event.type === "turn_end") queueCheckpoint();
    });

    try {
      await persistSession();
      signal.throwIfAborted();
      await session.prompt(input.prompt);
      if (latchedTransportError) await throwAfterDrain(latchedTransportError);
      await writer.drain();
      if (latchedTransportError) await throwAfterDrain(latchedTransportError);

      const assistant = [...session.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (!assistant) throw new Error("Pi completed without an assistant response");
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted")
        throw new Error(
          `Pi model stopped with ${assistant.stopReason}: ${assistant.errorMessage ?? "unknown provider error"}`,
        );
      const text = textFromMessages(session);
      if (!text.trim()) throw new Error("Pi completed without a textual assistant response");

      const metadata = sessionMetadata();
      await persistSession(metadata);
      await writer.drain();
      return { text, session: metadata };
    } catch (error) {
      await throwAfterDrain(error);
      // throwAfterDrain always throws; rethrow to satisfy the executor's
      // PiExecutorOutput return contract on every code path.
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }
  };
}
