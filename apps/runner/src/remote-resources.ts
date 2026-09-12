import { commandStdoutMaxBytes } from "./guest-command.js";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { posix } from "node:path";
import ignore from "ignore";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { ThreadStoreError } from "@cloud-swe/db/thread-contracts";
import { SandboxProviderError, type SandboxProvider, type WorkspaceRef } from "./sandbox.js";
import { quoteShell } from "./text.js";

const discoveryProgram = readFileSync(new URL("./guest/resources.py", import.meta.url), "utf8");

const resourcePathSchema = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      (path === "/workspace" || path.startsWith("/workspace/")) &&
      posix.normalize(path) === path &&
      !path.includes("\0"),
  );

const fileSchema = z.object({
  path: resourcePathSchema,
  canonical: resourcePathSchema,
  content: z.string().max(65536),
});

const snapshotSchema = z.object({
  entries: z
    .array(
      z.object({
        path: resourcePathSchema,
        canonical: resourcePathSchema,
        kind: z.enum(["directory", "file"]),
      }),
    )
    .max(10000),
  files: z.array(fileSchema).max(200),
});

type Captured = z.infer<typeof snapshotSchema>;

function decodeResources<T>(schema: z.ZodType<T>, json: string): T {
  try {
    return schema.parse(JSON.parse(json));
  } catch (error) {
    if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError)) throw error;
    throw new ThreadStoreError("RESOURCE_DISCOVERY_LIMIT", "Invalid remote resource data");
  }
}

export type RemoteResources = ReturnType<typeof resolveRemoteResources>;

const instructionNames = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

const frontmatterSchema = z.object({
  name: z.unknown().optional(),
  description: z.unknown().optional(),
  "disable-model-invocation": z.unknown().optional(),
});

export function resolveRemoteResources(captured: Captured, selectSkill?: (path: string) => void) {
  const instructions: Array<{ path: string; content: string }> = [];

  const skills: Array<{
    name: string;
    description: string;
    path: string;
    directory: string;
    body: string;
    disableModelInvocation: boolean;
  }> = [];

  const diagnostics: string[] = [];

  const note = (message: string) => {
    if (diagnostics.length < 100) diagnostics.push(message.slice(0, 1024));
  };

  const paths = new Set<string>();
  const names = new Set<string>();
  const files = new Map(captured.files.map((file) => [file.path, file]));

  for (const file of captured.files) {
    if (instructionNames.includes(posix.basename(file.path))) {
      instructions.push({
        path: file.path,
        content: `Instructions for directory ${posix.dirname(file.path)} and its descendants. Conflicting nested instructions apply only within their subtree.\n\n${file.content}`,
      });
    }
  }

  instructions.sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
  );

  for (const root of ["/workspace/.pi/skills", "/workspace/.agents/skills"]) {
    const matcher = ignore();
    const seenDirectories = new Set<string>();

    function walk(directory: string, rootFiles: boolean) {
      const entry = captured.entries.find((item) => item.path === directory);
      const canonical = entry?.canonical ?? directory;

      if (seenDirectories.has(canonical)) {
        note(`Skill directory cycle or collision: ${directory}`);

        return;
      }

      seenDirectories.add(canonical);
      const prefix = posix.relative(root, directory);

      for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
        const content = files.get(posix.join(directory, filename))?.content;

        if (content === undefined) continue;

        for (const line of content.split(/\r?\n/)) {
          if (!line.trim() || (line.trim().startsWith("#") && !line.trim().startsWith("\\#")))
            continue;
          let pattern = line;
          const negated = pattern.startsWith("!");

          if (negated || pattern.startsWith("\\!")) pattern = pattern.slice(1);

          if (pattern.startsWith("/")) pattern = pattern.slice(1);
          matcher.add(`${negated ? "!" : ""}${prefix ? prefix + "/" : ""}${pattern}`);
        }
      }

      function load(path: string) {
        selectSkill?.(path);
        const file = files.get(path);

        if (!file) return;
        let parsed;

        try {
          parsed = parseFrontmatter(file.content);
        } catch {
          note(`Malformed skill frontmatter: ${path}`);

          return;
        }

        const frontmatter = frontmatterSchema.safeParse(parsed.frontmatter);

        if (!frontmatter.success) {
          note(`Malformed skill frontmatter: ${path}`);

          return;
        }

        const description = z.string().safeParse(frontmatter.data.description).data;
        const name = z.string().safeParse(frontmatter.data.name).data || posix.basename(directory);

        if (!description?.trim()) {
          if (posix.basename(path) === "SKILL.md") note(`Skill description is missing: ${path}`);

          return;
        }

        if (
          description.length > 1024 ||
          name.length > 64 ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
        )
          note(`Skill name or description is invalid: ${path}`);

        if (paths.has(file.canonical) || names.has(name)) {
          note(`Skill collision: ${path}`);

          return;
        }

        paths.add(file.canonical);
        names.add(name);
        skills.push({
          name,
          description,
          path,
          directory,
          body: parsed.body,
          disableModelInvocation: frontmatter.data["disable-model-invocation"] === true,
        });
      }

      const declared = posix.join(directory, "SKILL.md");

      if (
        captured.entries.some((entry) => entry.path === declared && entry.kind === "file") &&
        !matcher.ignores(posix.relative(root, declared))
      ) {
        load(declared);

        return;
      }

      const children = captured.entries
        .filter((item) => posix.dirname(item.path) === directory)
        .sort((a, b) => a.path.localeCompare(b.path));

      for (const child of children) {
        const name = posix.basename(child.path);

        if (name.startsWith(".") || name === "node_modules") continue;

        if (
          matcher.ignores(
            posix.relative(root, child.path) + (child.kind === "directory" ? "/" : ""),
          )
        )
          continue;

        if (child.kind === "directory") walk(child.path, false);
        else if (rootFiles && name.endsWith(".md")) load(child.path);
      }
    }

    walk(root, true);
  }

  const catalog = skills
    .values()
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) =>
      JSON.stringify({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        directory: skill.directory,
      }),
    )
    .toArray()
    .join("\n");

  return {
    instructions,
    skills,
    diagnostics,
    catalog: catalog
      ? `Project skills: use remote_read to read the listed path when its description applies. Resolve references relative to the skill directory. Execute scripts only through remote_exec.\n${catalog}`
      : "",
  };
}

export function expandRemoteSkill(prompt: string, resources: RemoteResources): string {
  const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(prompt);

  if (!match) return prompt;
  const skill = resources.skills.find((item) => item.name === match[1]);

  if (!skill) return prompt;

  return `Project skill ${JSON.stringify(skill.name)} at ${JSON.stringify(skill.path)}. References are relative to ${JSON.stringify(skill.directory)}.\n\n${skill.body}\n\n${match[2] ?? ""}`;
}

export async function discoverRemoteResources(input: {
  sandbox: Pick<SandboxProvider, "exec">;
  workspace: WorkspaceRef;
  signal: AbortSignal;
  outputMaxBytes: number;
}): Promise<RemoteResources> {
  async function execute(command: string, stdin?: string) {
    const result = await input.sandbox.exec(input.workspace, { command, stdin }, input.signal);

    if (["unknown", "cancelled", "transport-timeout"].includes(result.kind))
      throw new SandboxProviderError(
        "unknown",
        "resource discovery",
        "Resource discovery transport is unresolved",
      );

    if (result.kind !== "completed" || result.statusCode !== 0 || result.outputTruncated)
      throw new ThreadStoreError("RESOURCE_DISCOVERY_LIMIT", "Remote resource discovery failed");

    return result.stdout;
  }

  async function capture(selected: string[] | null): Promise<Captured> {
    const path = `/tmp/cloud-swe-resources-${randomUUID()}.json`;

    const metadata = decodeResources(
      z.object({
        bytes: z.number().int().min(1).max(8000000),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      await execute(
        `python3 -c ${quoteShell(discoveryProgram)} ${quoteShell(path)}`,
        JSON.stringify(selected),
      ),
    );

    const pageSize = Math.min(
      49152,
      Math.floor(((commandStdoutMaxBytes(input.outputMaxBytes) - 256) * 3) / 4),
    );

    if (pageSize < 512)
      throw new ThreadStoreError(
        "RESOURCE_DISCOVERY_LIMIT",
        "Discovery output budget is too small",
      );
    const pages: Buffer[] = [];

    for (let offset = 0; offset < metadata.bytes; offset += pageSize) {
      const code = `import base64; f=open(${JSON.stringify(path)},'rb'); f.seek(${offset}); print(base64.b64encode(f.read(${pageSize})).decode())`;
      pages.push(Buffer.from((await execute(`python3 -c ${quoteShell(code)}`)).trim(), "base64"));
    }

    const bytes = Buffer.concat(pages);

    if (
      bytes.length !== metadata.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== metadata.hash
    )
      throw new ThreadStoreError(
        "RESOURCE_DISCOVERY_LIMIT",
        "Resource snapshot changed during transfer",
      );
    await execute(`rm -- ${quoteShell(path)}`);

    return decodeResources(snapshotSchema, bytes.toString("utf8"));
  }

  const captured = await capture(null);
  const selected: string[] = [];
  resolveRemoteResources(captured, (path) => selected.push(path));

  if (selected.length) captured.files.push(...(await capture(selected)).files);

  if (
    captured.files.length > 200 ||
    captured.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > 1048576
  )
    throw new ThreadStoreError("RESOURCE_DISCOVERY_LIMIT", "Resource content limit exceeded");

  return resolveRemoteResources(captured);
}
