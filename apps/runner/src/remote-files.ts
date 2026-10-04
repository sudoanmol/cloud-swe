import { quoteShell } from "./text.js";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";

const program = readFileSync(new URL("./guest/file-tools.py", import.meta.url), "utf8");

/** File tools accept the workspace and a scratch /tmp; the guest helper re-checks symlinks. */
export function toolFilePath(path: string): string {
  if (path.includes("\0") || path.split("/").includes(".."))
    throw new Error("Path must be under /workspace or /tmp without traversal");
  const normalized = posix.resolve("/workspace", path);

  if (!normalized.startsWith("/workspace/") && !normalized.startsWith("/tmp/"))
    throw new Error("Path must be under /workspace or /tmp");

  return normalized;
}

export const remoteFileCommand = `python3 -c ${quoteShell(program)}`;

export const editResultSchema = z.object({
  kind: z.literal("edit"),
  version: z.literal(1),
  path: z.string(),
  replacementCount: z.number().int().nonnegative(),
  unifiedDiff: z.string().max(65536),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
  afterHash: z.string().regex(/^[a-f0-9]{64}$/),
  diffTruncated: z.boolean(),
});

/**
 * Guest write result. `change` is reported by the guest from the descriptor it
 * actually opened; it is never inferred from an empty before-hash, because an
 * existing empty file is a replacement.
 */
export const writeResultSchema = z.object({
  kind: z.literal("write"),
  path: z.string(),
  change: z.enum(["created", "replaced"]),
  bytes: z.number().int().nonnegative(),
  preview: z.string().optional(),
  previewBytes: z.number().int().nonnegative().optional(),
  previewTruncated: z.boolean().optional(),
});

export function buildRemoteReadCommand(path: string) {
  return `printf %s ${quoteShell(JSON.stringify({ operation: "read", path: toolFilePath(path) }))} | ${remoteFileCommand}`;
}

export function buildRemoteWriteCommand(path: string, outputMaxBytes = 131072) {
  return `python3 -c ${quoteShell("import sys,json; print(json.dumps(dict(operation='write',path=sys.argv[1],content=sys.stdin.read(),outputMaxBytes=int(sys.argv[2]))))")} ${quoteShell(toolFilePath(path))} ${outputMaxBytes} | ${remoteFileCommand}`;
}
