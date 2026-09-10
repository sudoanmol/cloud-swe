import {
  isProcessResult,
  processResult,
  transportResult,
  type CommandRequest,
  type CommandResult,
  type WorkspaceRef,
} from "./sandbox.js";

export type ScriptedEvent = {
  type: "assistant.started" | "assistant.delta" | "tool.started" | "tool.output" | "tool.completed";
  dedupeKey: string;
  payload: Record<string, unknown>;
};

export type ScriptedCheckpoint = {
  load(key: string): Promise<Record<string, unknown> | undefined>;
  save(key: string, content: Record<string, unknown>): Promise<void>;
};

export type ScriptedCommandExecutor = (
  workspace: WorkspaceRef,
  request: CommandRequest,
  signal: AbortSignal,
) => Promise<CommandResult>;

export type ScriptedRunnerInput = {
  runId: string;
  prompt: string;
  workspace: WorkspaceRef;
  stepDelayMs: number;
  signal: AbortSignal;
  execute: ScriptedCommandExecutor;
  emit: (event: ScriptedEvent) => Promise<void>;
  checkpoint: ScriptedCheckpoint;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function outputPayload(result: CommandResult): Record<string, unknown> {
  if (isProcessResult(result))
    return {
      kind: result.kind,
      output: result.stdout,
      stderr: result.stderr,
      exitCode: result.statusCode,
      outputTruncated: result.outputTruncated,
    };
  return {
    kind: result.kind,
    output: result.stdout,
    stderr: result.stderr,
    exitCode: null,
    outputTruncated: result.outputTruncated,
    transportFailure: result.kind,
    diagnostic: result.error,
  };
}

function commandFromCheckpoint(content: Record<string, unknown>): CommandResult | undefined {
  const kind = content.kind;
  const stdout = content.output;
  const stderr = content.stderr;
  const outputTruncated = content.outputTruncated;
  if (
    typeof kind !== "string" ||
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    typeof outputTruncated !== "boolean"
  )
    return undefined;
  if (kind === "completed" || kind === "failed") {
    const exitCode = content.exitCode;
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) return undefined;
    return processResult(stdout, stderr, exitCode, outputTruncated);
  }
  if (
    kind === "transport-timeout" ||
    kind === "cancelled" ||
    kind === "unknown" ||
    kind === "output-limit"
  )
    return transportResult(
      kind,
      typeof content.diagnostic === "string" ? content.diagnostic : undefined,
      stdout,
      stderr,
      outputTruncated,
    );
  return undefined;
}

function commandFailure(result: CommandResult): never {
  if (isProcessResult(result)) {
    const diagnostic = `${result.stderr || result.stdout}`.trim().slice(0, 500);
    throw new Error(
      `Scripted workspace command exited with ${result.statusCode}${diagnostic ? `: ${diagnostic}` : ""}`,
    );
  }
  const diagnostic = `${result.stderr || result.stdout}`.trim().slice(0, 500);
  throw new Error(
    `Scripted workspace command returned ${result.kind}${diagnostic ? `: ${diagnostic}` : ""}`,
  );
}

async function waitBetweenSteps(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Scripted execution cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function runScripted(input: ScriptedRunnerInput): Promise<string> {
  const { checkpoint, emit, signal } = input;
  const runStep = async (
    key: string,
    action: () => Promise<Record<string, unknown> | undefined>,
  ): Promise<Record<string, unknown>> => {
    signal.throwIfAborted();
    const saved = await checkpoint.load(key);
    if (saved) return saved;
    const content = (await action()) ?? {};
    await checkpoint.save(key, { version: 1, kind: "scripted", key, ...content });
    await waitBetweenSteps(input.stepDelayMs, signal);
    return content;
  };

  await runStep("scripted-step-1", async () => {
    await emit({
      type: "assistant.started",
      dedupeKey: `run:${input.runId}:assistant-started`,
      payload: { runId: input.runId },
    });
    return undefined;
  });

  let commandResult: CommandResult = processResult("", "", 1);
  const commandCheckpoint = await runStep("scripted-step-2", async () => {
    await emit({
      type: "tool.started",
      dedupeKey: `run:${input.runId}:tool-started`,
      payload: {
        runId: input.runId,
        name: "shell",
        command: "Write and read a scripted workspace result",
      },
    });
    commandResult = await input.execute(
      input.workspace,
      {
        command: `mkdir -p -- /workspace/runs/${shellQuote(input.runId)} && cat > /workspace/runs/${shellQuote(input.runId)}/prompt.txt && printf 'scripted runner completed\\n' > /workspace/runs/${shellQuote(input.runId)}/result.txt && cat -- /workspace/runs/${shellQuote(input.runId)}/result.txt`,
        stdin: input.prompt,
        timeoutMs: 20_000,
      },
      signal,
    );
    await emit({
      type: "tool.output",
      dedupeKey: `run:${input.runId}:tool-output`,
      payload: { runId: input.runId, ...outputPayload(commandResult) },
    });
    await emit({
      type: "tool.completed",
      dedupeKey: `run:${input.runId}:tool-completed`,
      payload: {
        runId: input.runId,
        name: "shell",
        exitCode: isProcessResult(commandResult) ? commandResult.statusCode : null,
        isError: !isProcessResult(commandResult) || commandResult.statusCode !== 0,
      },
    });
    return outputPayload(commandResult);
  });
  const restoredCommand = commandFromCheckpoint(commandCheckpoint);
  if (restoredCommand) commandResult = restoredCommand;
  if (!isProcessResult(commandResult) || commandResult.statusCode !== 0)
    commandFailure(commandResult);

  const chunks = [
    "The scripted workspace check ",
    "completed successfully. ",
    "The result is saved in the workspace.",
  ];
  for (const [index, content] of chunks.entries()) {
    await runStep(`scripted-step-${index + 3}`, async () => {
      await emit({
        type: "assistant.delta",
        dedupeKey: `run:${input.runId}:delta:${index}`,
        payload: { runId: input.runId, content, delta: index },
      });
      return undefined;
    });
  }

  return chunks.join("");
}
