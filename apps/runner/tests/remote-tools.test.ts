import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  remoteFileCommand,
  editResultSchema,
  buildRemoteWriteCommand,
  buildRemoteReadCommand,
} from "../src/remote-files.js";
import { discoverRemoteResources, expandRemoteSkill } from "../src/remote-resources.js";
import { processResult, type WorkspaceRef } from "../src/sandbox.js";

const container = `cloud-swe-tools-${randomUUID()}`;

const workspace: WorkspaceRef = {
  id: "test",
  threadId: "test",
  name: container,
  provider: "docker",
  providerId: container,
  generation: 1,
};

async function exec(command: string, stdin?: string) {
  const child = Bun.spawn(["docker", "exec", "-i", container, "sh", "-lc", command], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, statusCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return processResult(stdout, stderr, statusCode);
}

async function file(input: {
  operation: string;
  path: string;
  oldText?: string;
  newText?: string;
  content?: string;
  replaceAll?: boolean;
  outputMaxBytes?: number;
}) {
  return exec(remoteFileCommand, JSON.stringify(input));
}

beforeAll(async () => {
  const process = Bun.spawn(
    [
      "docker",
      "run",
      "-d",
      "--name",
      container,
      "--network",
      "none",
      "cloud-swe-local-tests",
      "sleep",
      "infinity",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );

  expect(await process.exited, await new Response(process.stderr).text()).toBe(0);
  expect((await exec("mkdir /workspace")).statusCode).toBe(0);
});

afterAll(async () => {
  await Bun.spawn(["docker", "rm", "-f", container], { stdout: "ignore", stderr: "ignore" }).exited;
});

test("literal edits preserve CRLF, non-ASCII bytes and permissions; ambiguity never mutates", async () => {
  expect(
    (await file({ operation: "write", path: "space dir/a.txt", content: "café\r\nold\r\nold\r\n" }))
      .statusCode,
  ).toBe(0);
  await exec("chmod 751 '/workspace/space dir/a.txt'");

  const ambiguous = await file({
    operation: "edit",
    path: "space dir/a.txt",
    oldText: "old",
    newText: "new",
  });

  expect(ambiguous.statusCode).toBe(1);
  expect(ambiguous.stderr).toContain("ambiguous");

  const edited = await file({
    operation: "edit",
    path: "space dir/a.txt",
    oldText: "old",
    newText: "new",
    replaceAll: true,
  });

  expect(edited.statusCode, edited.stderr).toBe(0);
  const result = editResultSchema.parse(JSON.parse(edited.stdout));
  expect(result).toMatchObject({
    replacementCount: 2,
    additions: 2,
    deletions: 2,
    diffTruncated: false,
  });
  expect(result.beforeHash).not.toBe(result.afterHash);
  expect((await exec("cat '/workspace/space dir/a.txt'")).stdout).toBe("café\r\nnew\r\nnew\r\n");
  expect((await exec("stat -c %a '/workspace/space dir/a.txt'")).stdout.trim()).toBe("751");
});

test("file tools reject traversal, escaping symlinks, binary, invalid UTF-8 and special files", async () => {
  await exec(
    "ln -s /etc /workspace/escape; mkfifo /workspace/pipe; printf '\\377' > /workspace/encoding; printf '\\000' > /workspace/binary",
  );

  for (const path of ["../etc/passwd", "escape/passwd", "pipe", "encoding", "binary"])
    expect((await file({ operation: "read", path })).statusCode, path).toBe(1);

  for (const path of ["../outside", "escape/passwd"])
    expect((await file({ operation: "write", path, content: "no" })).statusCode, path).toBe(1);
});

test("replacement inputs and files are bounded and encoded diffs fit the output budget", async () => {
  expect(
    (await file({ operation: "write", path: "large", content: "a".repeat(1048577) })).statusCode,
  ).toBe(1);
  await file({ operation: "write", path: "diff", content: '"a"\n'.repeat(20000) });

  const result = await file({
    operation: "edit",
    path: "diff",
    oldText: "a",
    newText: "b",
    replaceAll: true,
    outputMaxBytes: 4096,
  });

  expect(result.statusCode, result.stderr).toBe(0);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4096);
  expect(editResultSchema.parse(JSON.parse(result.stdout)).diffTruncated).toBe(true);
  const zero = await file({ operation: "edit", path: "diff", oldText: "absent", newText: "x" });
  expect(zero.statusCode).toBe(1);
  const empty = await file({ operation: "edit", path: "diff", oldText: "", newText: "x" });
  expect(empty.statusCode).toBe(1);
});

test("Pi file command wrappers deliver structured input safely for spaces", async () => {
  const write = await exec(buildRemoteWriteCommand("another dir/file.txt"), "a\nb\r\n");
  expect(write.statusCode, write.stderr).toBe(0);
  expect((await exec(buildRemoteReadCommand("another dir/file.txt"))).stdout).toBe("a\nb\r\n");
});

test("resource snapshots honor nested precedence, skill ignores and invocation while refreshing between attempts", async () => {
  await exec(
    "rm -f /workspace/pipe /workspace/encoding /workspace/binary; mkdir -p /workspace/sub /workspace/.pi/skills/fix /workspace/.agents/skills/fix /workspace/.agents/skills/manual",
  );

  for (const [path, content] of [
    ["AGENTS.md", "root instructions"],
    ["CLAUDE.md", "lower precedence"],
    ["sub/AGENTS.override.md", "nested instructions"],
    [".pi/skills/fix/SKILL.md", "---\nname: fix\ndescription: Fix tests\n---\nUse ./script.sh"],
    [".agents/skills/fix/SKILL.md", "---\nname: fix\ndescription: Collision\n---\nWrong"],
    [
      ".agents/skills/manual/SKILL.md",
      "---\nname: manual\ndescription: Manual skill\ndisable-model-invocation: true\n---\nManual content",
    ],
    [".agents/skills/.ignore", "ignored.md"],
    [".agents/skills/ignored.md", "---\nname: ignored\ndescription: ignored\n---\nignored"],
  ])
    await file({ operation: "write", path: path ?? "", content: content ?? "" });
  await exec("ln -s /workspace/.pi/skills /workspace/.pi/skills/cycle");

  const input = {
    sandbox: {
      exec: async (_workspace: WorkspaceRef, request: { command: string }) => exec(request.command),
    },
    workspace,
    signal: new AbortController().signal,
    outputMaxBytes: 4096,
  };

  const resources = await discoverRemoteResources(input);
  expect(resources.instructions.map((item) => item.path)).toEqual([
    "/workspace/AGENTS.md",
    "/workspace/sub/AGENTS.override.md",
  ]);
  expect(resources.catalog).toContain("remote_read");
  expect(resources.catalog).not.toContain("Manual skill");
  expect(resources.skills.map((item) => item.name)).toEqual(["fix", "manual"]);
  expect(resources.diagnostics.join("\n")).toContain("collision");
  expect(expandRemoteSkill("/skill:manual now", resources)).toContain("Manual content");
  expect(expandRemoteSkill("/skill:fix", resources)).toContain("/workspace/.pi/skills/fix");
  await file({ operation: "write", path: "AGENTS.md", content: "changed" });
  expect(resources.instructions[0]?.content).toContain("root instructions");
  expect((await discoverRemoteResources(input)).instructions[0]?.content).toContain("changed");
});

test("edits return a valid diff for files without a final newline", async () => {
  await file({ operation: "write", path: "no-newline", content: "old" });

  const result = await file({
    operation: "edit",
    path: "no-newline",
    oldText: "old",
    newText: "new",
  });

  expect(editResultSchema.parse(JSON.parse(result.stdout)).unifiedDiff).toContain(
    "-old\n\\ No newline at end of file\n+new\n",
  );
  expect((await exec("cat /workspace/no-newline")).stdout).toBe("new");
});

test("resource decoding rejects malformed data and escaping paths without hiding transport failures", async () => {
  const input = { workspace, signal: new AbortController().signal, outputMaxBytes: 4096 };
  const invalidSnapshots = ["{", JSON.stringify({ entries: [], files: [{}] })];

  for (const path of [
    "/etc/AGENTS.md",
    "/workspace/../AGENTS.md",
    "/workspace-x/AGENTS.md",
    "/workspace/\0",
  ])
    for (const field of ["path", "canonical"])
      invalidSnapshots.push(
        JSON.stringify({
          entries: [],
          files: [
            {
              path: "/workspace/AGENTS.md",
              canonical: "/workspace/AGENTS.md",
              content: "",
              [field]: path,
            },
          ],
        }),
      );

  const responses = [
    ["{"],
    [JSON.stringify({ bytes: 8000001, hash: "a".repeat(64) })],
    ...invalidSnapshots.map((snapshot) => [
      JSON.stringify({
        bytes: Buffer.byteLength(snapshot),
        hash: createHash("sha256").update(snapshot).digest("hex"),
      }),
      Buffer.from(snapshot).toString("base64"),
      "",
    ]),
  ];

  for (const outputs of responses)
    await expect(
      discoverRemoteResources({
        ...input,
        sandbox: { exec: async () => processResult(outputs.shift() ?? "", "", 0) },
      }),
    ).rejects.toMatchObject({
      code: "RESOURCE_DISCOVERY_LIMIT",
      message: "Invalid remote resource data",
    });

  const transportFailure = new SyntaxError("transport decoding failure");
  await expect(
    discoverRemoteResources({
      ...input,
      sandbox: {
        exec: async () => {
          throw transportFailure;
        },
      },
    }),
  ).rejects.toBe(transportFailure);
});
