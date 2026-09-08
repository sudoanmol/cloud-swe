import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentToolResult,
  type AgentSessionEvent,
  type FileEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { posix } from "node:path";
import type { CommandRequest, CommandResult, SandboxProvider, WorkspaceRef } from "./sandbox.js";

const workspaceRoot = "/workspace";

const execParameters = Type.Object({ command: Type.String() });
const readParameters = Type.Object({ path: Type.String() });
const writeParameters = Type.Object({ path: Type.String(), content: Type.String() });

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

export interface PiExecutorConfig {
  sandbox: SandboxProvider;
  workspace: WorkspaceRef;
  piProvider?: string;
  piModel?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  aiGatewayApiKey: string;
  emit: (event: PiEvent) => void | Promise<void>;
  checkpoint?: (metadata: PiSessionMetadata) => void | Promise<void>;
}

export interface PiExecutorInput {
  prompt: string;
  signal?: AbortSignal;
  runId: string;
  sessionEntries?: FileEntry[];
  workspace?: WorkspaceRef;
}

export interface PiSessionMetadata {
  sessionId: string;
  provider: string;
  model: string;
  entries: FileEntry[];
}

export interface PiExecutorOutput {
  text: string;
  session: PiSessionMetadata;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function workspacePath(path: string): string {
  if (path.includes("\0")) throw new Error("Path contains a NUL byte");
  const normalized = posix.resolve(path.startsWith("/") ? path : posix.join(workspaceRoot, path));
  if (normalized !== workspaceRoot && !normalized.startsWith(`${workspaceRoot}/`)) {
    throw new Error("Path must remain inside /workspace");
  }
  return normalized;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? String(value))
    .digest("hex")
    .slice(0, 16);
}

function commandOutput(result: CommandResult): string {
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
  if (result.statusCode !== 0)
    throw new Error(output || `Remote command exited with ${result.statusCode}`);
  return output;
}

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: undefined };
}

function textFromMessages(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
): string {
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

export function createPiExecutor(config: PiExecutorConfig) {
  return async function execute(input: PiExecutorInput): Promise<PiExecutorOutput> {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const workspace = input.workspace ?? config.workspace;
    const runtime = await ModelRuntime.create({
      credentials: createInMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const provider = config.piProvider ?? "vercel-ai-gateway";
    const modelId = config.piModel ?? "meta/muse-spark-1.3-contributor";
    await runtime.setRuntimeApiKey("vercel-ai-gateway", config.aiGatewayApiKey);
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);

    const sessionManager = input.sessionEntries
      ? SessionManager.inMemory(workspaceRoot, undefined, input.sessionEntries)
      : SessionManager.inMemory(workspaceRoot);

    let deltaCounter = 0;
    const emit = async (
      event: PiEventType,
      dedupeKey: string,
      payload: Record<string, unknown>,
    ) => {
      await config.emit({ type: event, dedupeKey, payload });
    };

    const remoteExec = async (
      command: string,
      toolCallId: string,
      toolSignal: AbortSignal | undefined,
      stdin?: string,
    ) => {
      const effectiveSignal = toolSignal ?? signal;
      effectiveSignal.throwIfAborted();
      const request: CommandRequest = { command: `cd ${workspaceRoot} && ${command}`, stdin };
      const result = await config.sandbox.exec(workspace, request, effectiveSignal);
      const output = commandOutput(result);
      await emit("tool.output", `tool:${toolCallId}:output:${fingerprint(output)}`, {
        toolCallId,
        output,
      });
      return output;
    };

    const execTool: ToolDefinition<typeof execParameters, unknown, unknown> = {
      name: "remote_exec",
      label: "Remote exec",
      description: "Execute a shell command in the remote workspace.",
      parameters: execParameters,
      execute: async (toolCallId, params, toolSignal) =>
        textResult(await remoteExec(params.command, toolCallId, toolSignal)),
    };
    const readTool: ToolDefinition<typeof readParameters, unknown, unknown> = {
      name: "remote_read",
      label: "Remote read",
      description: "Read a file from the remote workspace.",
      parameters: readParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const path = workspacePath(params.path);
        const output = await remoteExec(`cat -- ${quoteShell(path)}`, toolCallId, toolSignal);
        return textResult(output);
      },
    };
    const writeTool: ToolDefinition<typeof writeParameters, unknown, unknown> = {
      name: "remote_write",
      label: "Remote write",
      description: "Write a file in the remote workspace.",
      parameters: writeParameters,
      execute: async (toolCallId, params, toolSignal) => {
        const path = workspacePath(params.path);
        const output = await remoteExec(
          `mkdir -p -- $(dirname -- ${quoteShell(path)}) && cat > ${quoteShell(path)}`,
          toolCallId,
          toolSignal,
          params.content,
        );
        return textResult(output || "Wrote file successfully.");
      },
    };
    const tools = [execTool, readTool, writeTool];

    const created = await createAgentSession({
      cwd: workspaceRoot,
      modelRuntime: runtime,
      model,
      thinkingLevel: config.thinkingLevel,
      tools: ["remote_exec", "remote_read", "remote_write"],
      customTools: tools,
      sessionManager,
    });
    const session = created.session;
    const sessionMetadata = (): PiSessionMetadata => {
      const header = sessionManager.getHeader();
      if (!header) throw new Error("Pi session is missing its header");
      return {
        sessionId: session.sessionId,
        provider,
        model: modelId,
        entries: [header, ...sessionManager.getEntries()],
      };
    };
    const persistSession = async () => {
      await config.checkpoint?.(sessionMetadata());
    };
    const onAbort = () => void session.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let pendingEvents = Promise.resolve();
    const queueEvent = (
      event: PiEventType,
      dedupeKey: string,
      payload: Record<string, unknown>,
    ): void => {
      pendingEvents = pendingEvents.then(() => emit(event, dedupeKey, payload));
    };
    const queueCheckpoint = (): void => {
      pendingEvents = pendingEvents.then(persistSession);
    };
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "agent_start") queueEvent("assistant.started", "assistant:started", {});
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const counter = deltaCounter++;
        queueEvent(
          "assistant.delta",
          `assistant:delta:${input.runId}:${counter}:${fingerprint(event.assistantMessageEvent.delta)}`,
          {
            content: event.assistantMessageEvent.delta,
            delta: counter,
          },
        );
      }
      if (event.type === "tool_execution_start")
        queueEvent("tool.started", `tool:${event.toolCallId}:started`, {
          toolCallId: event.toolCallId,
          name: event.toolName,
        });
      if (event.type === "tool_execution_update")
        queueEvent(
          "tool.output",
          `tool:${event.toolCallId}:output:${fingerprint(event.partialResult)}`,
          {
            toolCallId: event.toolCallId,
            output: event.partialResult,
          },
        );
      if (event.type === "tool_execution_end")
        queueEvent("tool.completed", `tool:${event.toolCallId}:completed`, {
          toolCallId: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
        });
      if (
        event.type === "agent_end" ||
        event.type === "turn_end" ||
        event.type === "entry_appended"
      )
        queueCheckpoint();
    });
    try {
      await persistSession();
      signal.throwIfAborted();
      await session.prompt(input.prompt);
      await pendingEvents;
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
      await config.checkpoint?.(metadata);
      return { text, session: metadata };
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }
  };
}
