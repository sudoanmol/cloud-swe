import { z } from "zod";
import type { ProjectedToolPart, TranscriptEntry } from "./chat-types";

export function safeWebUrl(value: string): string | undefined {
  try {
    const url = new URL(value);

    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function commandOutput(part: ProjectedToolPart) {
  if (part.legacy) {
    const streams = [part.legacy.stdout, part.legacy.stderr].filter(Boolean).join("\n");

    return {
      text: streams || part.legacy.output || part.finalOutput || "",
      truncated: part.legacy.outputTruncated,
    };
  }

  if (part.finalOutput !== null) return { text: part.finalOutput, truncated: false };

  return {
    text: [part.live.stdout, part.live.stderr].filter(Boolean).join("\n"),
    truncated: part.live.truncated,
  };
}

const commandSchema = z.object({ command: z.string() });

type ToolGroupLabel = "Exploring" | "File changes" | "Web research" | "Bash commands";

function groupLabel(part: ProjectedToolPart): ToolGroupLabel | null {
  if (part.state === "failed") return null;

  if (part.name === "remote_read") return "Exploring";

  if (part.name === "remote_edit" || part.name === "remote_write") return "File changes";

  if (part.name === "web_search" || part.name === "web_fetch") return "Web research";

  if (part.name !== "remote_exec") return null;
  const parsed = commandSchema.safeParse(part.args);

  // Only simple literal arguments qualify. Pipes, quoting, substitutions and
  // compound commands remain Bash; this label never authorizes execution.
  if (
    parsed.success &&
    /^(?:ls|pwd|cat|head|tail|rg|grep)(?:[ \t]+[\w./,:=@%+-]+)*[ \t]*$/.test(parsed.data.command)
  )
    return "Exploring";

  return "Bash commands";
}

export type ToolGroup = {
  kind: "tool-group";
  key: string;
  label: ToolGroupLabel;
  runId: string;
  attemptId: string;
  parts: ProjectedToolPart[];
};

/** Only adjacency can join calls: any message/marker/error closes a group. */
export function groupTranscript(
  entries: readonly TranscriptEntry[],
): (TranscriptEntry | ToolGroup)[] {
  const result: (TranscriptEntry | ToolGroup)[] = [];

  for (const entry of entries) {
    const label = entry.kind === "tool" ? groupLabel(entry.part) : null;

    if (entry.kind !== "tool" || label === null) {
      result.push(entry);
      continue;
    }

    const previous = result.at(-1);

    if (
      previous?.kind === "tool-group" &&
      previous.label === label &&
      previous.runId === entry.runId &&
      previous.attemptId === entry.part.attemptId
    ) {
      previous.parts.push(entry.part);
    } else {
      result.push({
        kind: "tool-group",
        key: entry.key,
        label,
        runId: entry.runId,
        attemptId: entry.part.attemptId,
        parts: [entry.part],
      });
    }
  }

  return result;
}
