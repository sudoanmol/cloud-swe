import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";

const program = readFileSync(new URL("./guest/file-tools.py", import.meta.url), "utf8");

export function quoteShell(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function workspacePath(path: string): string {
  if (path.includes("\0") || path.split("/").includes(".."))
    throw new Error("Path must remain inside /workspace without traversal");
  const normalized = posix.resolve("/workspace", path);

  if (!normalized.startsWith("/workspace/")) throw new Error("Path must remain inside /workspace");

  return normalized;
}

export const remoteFileCommand = `python3 -c ${quoteShell(program)}`;

export const editResultSchema = z.object({
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

export function buildRemoteReadCommand(path: string) {
  return `printf %s ${quoteShell(JSON.stringify({ operation: "read", path: workspacePath(path) }))} | ${remoteFileCommand}`;
}

export function buildRemoteWriteCommand(path: string) {
  return `python3 -c ${quoteShell("import sys,json; print(json.dumps(dict(operation='write',path=sys.argv[1],content=sys.stdin.read())))")} ${quoteShell(workspacePath(path))} | ${remoteFileCommand}`;
}
