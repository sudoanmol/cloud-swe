import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseProjectToolFailure } from "@cloud-swe/db/checkpoint";
import { publicFailureMessage } from "@cloud-swe/db/public-failure";
import { commandStdoutMaxBytes } from "./guest-command.js";
import type { PiCommandDiagnostic } from "./pi-command.js";
import {
  buildRemoteReadCommand,
  buildRemoteWriteCommand,
  remoteFileCommand,
  editResultSchema,
  writeResultSchema,
} from "./remote-files.js";

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
  path: Type.String({
    description:
      "File path under /workspace, /tmp, or /root/.agents (relative paths resolve from /workspace)",
  }),
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

function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return { content: [{ type: "text", text }], details };
}

/** Runs one command in the workspace through the execution coordinator. */
export type RemoteExec = (
  command: string,
  toolCallId: string,
  toolSignal: AbortSignal | undefined,
  stdin?: string,
  access?: "read" | "exclusive",
  liveOutput?: boolean,
  timeoutMs?: number,
) => Promise<PiCommandDiagnostic>;

/** The shell and file tools; every one of them reaches the workspace only through `remoteExec`. */
export function createRemoteTools(
  remoteExec: RemoteExec,
  outputMaxBytes: number,
): ToolDefinition[] {
  const bashTool: ToolDefinition<typeof bashParameters, unknown, unknown> = {
    name: "bash",
    label: "bash",
    promptSnippet: "Execute bash commands in /workspace (ls, rg, find, git, builds, tests)",
    promptGuidelines: [
      `bash commands time out after ${defaultCommandTimeoutSeconds} seconds; pass timeout (up to ${maxCommandTimeoutSeconds}) for longer builds and test suites`,
    ],
    description: `Execute a bash command in /workspace. Returns stdout, stderr and the exit code. Output is truncated to ${outputMaxBytes} bytes. Commands time out after ${defaultCommandTimeoutSeconds} seconds unless a timeout of up to ${maxCommandTimeoutSeconds} seconds is given.`,
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
        buildRemoteWriteCommand(params.path, commandStdoutMaxBytes(outputMaxBytes)),
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
          outputMaxBytes: commandStdoutMaxBytes(outputMaxBytes),
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

  return [bashTool, readTool, writeTool, editTool];
}
