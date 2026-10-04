import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  remoteFileCommand,
  editResultSchema,
  writeResultSchema,
  buildRemoteWriteCommand,
  buildRemoteReadCommand,
} from "../src/remote-files.js";
import {
  buildGuestCommandRequest,
  buildGuestProgressRequest,
  guestCommandStateIsSettled,
  newCommandOwner,
  parseGuestCommandObservation,
  parseGuestProgressObservation,
  type GuestCommandOwner,
} from "../src/guest-command.js";
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
  edits?: { oldText: string; newText: string }[];
  content?: string;
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
  const content = "café\r\nold one\r\nold two\r\n";

  expect((await file({ operation: "write", path: "space dir/a.txt", content })).statusCode).toBe(0);
  await exec("chmod 751 '/workspace/space dir/a.txt'");

  const ambiguous = await file({
    operation: "edit",
    path: "space dir/a.txt",
    edits: [
      { oldText: "café", newText: "cafe" },
      { oldText: "old", newText: "new" },
    ],
  });

  expect(ambiguous.statusCode).toBe(1);
  expect(JSON.parse(ambiguous.stderr)).toMatchObject({
    code: "ambiguous-literal-match",
    editIndex: 1,
    matchCount: 2,
  });

  const overlapping = await file({
    operation: "edit",
    path: "space dir/a.txt",
    edits: [
      { oldText: "old one\r\nold", newText: "x" },
      { oldText: "one\r\nold two", newText: "y" },
    ],
  });

  expect(overlapping.statusCode).toBe(1);
  expect(overlapping.stderr).toContain("overlap");
  expect((await exec("cat '/workspace/space dir/a.txt'")).stdout).toBe(content);

  // Every edit matches the original file, so the second edit is unaffected by the first.
  const edited = await file({
    operation: "edit",
    path: "space dir/a.txt",
    edits: [
      { oldText: "old two", newText: "new two" },
      { oldText: "old one", newText: "new one" },
    ],
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
  expect((await exec("cat '/workspace/space dir/a.txt'")).stdout).toBe(
    "café\r\nnew one\r\nnew two\r\n",
  );
  expect((await exec("stat -c %a '/workspace/space dir/a.txt'")).stdout.trim()).toBe("751");
});

test("file tools reject traversal, escaping symlinks, binary, invalid UTF-8 and special files", async () => {
  await exec(
    "ln -s /etc /workspace/escape; mkfifo /workspace/pipe; printf '\\377' > /workspace/encoding; printf '\\000' > /workspace/binary",
  );

  for (const path of ["../etc/passwd", "escape/passwd", "pipe", "encoding", "binary"])
    expect((await file({ operation: "read", path })).statusCode, path).toBe(1);

  for (const path of ["../outside", "escape/passwd", "/etc/scratch", "/tmpfile"])
    expect((await file({ operation: "write", path, content: "no" })).statusCode, path).toBe(1);
});

test("file tools accept /tmp scratch files", async () => {
  const write = await file({ operation: "write", path: "/tmp/scratch/check.ts", content: "a" });
  expect(write.statusCode, write.stderr).toBe(0);

  const edit = await file({
    operation: "edit",
    path: "/tmp/scratch/check.ts",
    edits: [{ oldText: "a", newText: "b" }],
  });

  expect(edit.statusCode, edit.stderr).toBe(0);
  expect(editResultSchema.parse(JSON.parse(edit.stdout)).unifiedDiff).toContain(
    "+++ b/tmp/scratch/check.ts",
  );
  expect((await file({ operation: "read", path: "/tmp/scratch/check.ts" })).stdout).toBe("b");
});

test("replacement inputs and files are bounded and encoded diffs fit the output budget", async () => {
  expect(
    (await file({ operation: "write", path: "large", content: "a".repeat(1048577) })).statusCode,
  ).toBe(1);
  await file({ operation: "write", path: "diff", content: '"a"\n'.repeat(20000) });

  const result = await file({
    operation: "edit",
    path: "diff",
    edits: [{ oldText: '"a"\n'.repeat(20000), newText: '"b"\n'.repeat(20000) }],
    outputMaxBytes: 4096,
  });

  expect(result.statusCode, result.stderr).toBe(0);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4096);
  expect(editResultSchema.parse(JSON.parse(result.stdout)).diffTruncated).toBe(true);

  const zero = await file({
    operation: "edit",
    path: "diff",
    edits: [{ oldText: "absent", newText: "x" }],
  });

  expect(JSON.parse(zero.stderr)).toMatchObject({ code: "no-literal-match", editIndex: 0 });

  const empty = await file({
    operation: "edit",
    path: "diff",
    edits: [{ oldText: "", newText: "x" }],
  });

  expect(empty.statusCode).toBe(1);
  expect((await file({ operation: "edit", path: "diff", edits: [] })).statusCode).toBe(1);
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
      exec: async (_workspace: WorkspaceRef, request: { command: string; stdin?: string }) =>
        exec(request.command, request.stdin),
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
  expect(resources.catalog).toContain("read");
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
    edits: [{ oldText: "old", newText: "new" }],
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

test("guest writes report created/replaced as an explicit fact, never inferred", async () => {
  const created = await file({ operation: "write", path: "facts/new.txt", content: "fresh" });

  expect(created.statusCode, created.stderr).toBe(0);
  expect(writeResultSchema.parse(JSON.parse(created.stdout))).toMatchObject({
    kind: "write",
    change: "created",
    bytes: 5,
    preview: "fresh",
    previewTruncated: false,
  });

  const replaced = await file({ operation: "write", path: "facts/new.txt", content: "again" });

  expect(writeResultSchema.parse(JSON.parse(replaced.stdout))).toMatchObject({
    change: "replaced",
    bytes: 5,
  });

  // An existing empty file is a replacement, not a creation.
  expect(
    (await exec("mkdir -p /workspace/facts && : > /workspace/facts/empty.txt")).statusCode,
  ).toBe(0);
  const empty = await file({ operation: "write", path: "facts/empty.txt", content: "now filled" });

  expect(writeResultSchema.parse(JSON.parse(empty.stdout))).toMatchObject({ change: "replaced" });

  // The preview is bounded while the byte count stays exact.
  const large = await file({
    operation: "write",
    path: "facts/large.txt",
    content: "x".repeat(20_000),
  });

  const largeResult = writeResultSchema.parse(JSON.parse(large.stdout));

  expect(largeResult.bytes).toBe(20_000);
  expect(largeResult.previewTruncated).toBe(true);
  expect(Buffer.byteLength(largeResult.preview ?? "", "utf8")).toBeLessThanOrEqual(8192);
});

function progressWorkspace(id: string): WorkspaceRef {
  return { ...workspace, id };
}

async function fencedCommand(owner: GuestCommandOwner, command: string, timeoutMs = 20_000) {
  const fenced = buildGuestCommandRequest({
    owner,
    request: { command, timeoutMs },
    outputMaxBytes: 65_536,
  });

  // Detached so a live command can be observed while it runs.
  const started = await exec(`{\n${fenced.command}\n} >/tmp/fenced.log 2>&1 &`, fenced.stdin);

  expect(started.statusCode, started.stderr).toBe(0);
}

async function pollProgress(owner: GuestCommandOwner, offset = { stdout: 0, stderr: 0 }) {
  const request = buildGuestProgressRequest({
    owner,
    offsets: offset,
    limits: { stdout: 32_768, stderr: 32_768 },
    timeoutMs: 10_000,
  });

  return parseGuestProgressObservation(await exec(request.command), owner);
}

test("the real guest journal serves bounded live chunks with explicit byte offsets", async () => {
  const owner = newCommandOwner({
    workspace: progressWorkspace("progress-live"),
    runId: "run-progress",
    attemptId: "attempt-progress",
  });

  await fencedCommand(owner, "printf 'h\\303\\251llo'; sleep 1.2; printf ' tail'");

  // Poll until the first bytes appear, then confirm the offset resume.
  let observation = await pollProgress(owner);

  for (let attempt = 0; attempt < 40 && observation.chunks.length === 0; attempt++) {
    await Bun.sleep(50);
    observation = await pollProgress(owner);
  }

  expect(observation.available).toBe(true);
  const first = observation.chunks.find((chunk) => chunk.stream === "stdout");

  expect(first?.offset).toBe(0);
  expect(first?.bytes.toString("utf8")).toContain("héllo");

  const expected = first?.bytes.length ?? 0;
  const next = await pollProgress(owner, { stdout: expected, stderr: 0 });

  expect(next.available).toBe(true);
  expect(next.chunks.every((chunk) => chunk.stream !== "stdout" || chunk.offset === expected)).toBe(
    true,
  );

  // The command still settles through the normal journal path.
  for (let attempt = 0; attempt < 60; attempt++) {
    const settled = parseGuestCommandObservation(
      await exec(
        buildGuestProgressRequest({
          owner,
          offsets: { stdout: 0, stderr: 0 },
          limits: { stdout: 0, stderr: 0 },
          timeoutMs: 10_000,
        }).command,
      ),
      owner,
    );

    if (guestCommandStateIsSettled(settled.state)) break;
    await Bun.sleep(100);
  }
});

test("a substituted journal reports no progress instead of following a symlink", async () => {
  const owner = newCommandOwner({
    workspace: progressWorkspace("progress-symlink"),
    runId: "run-progress",
    attemptId: "attempt-progress",
  });

  const directory = `/tmp/cloud-swe-commands/${owner.workspace.id}/${owner.commandId}`;

  await fencedCommand(owner, "printf 'live output'", 20_000);

  // Wait for settlement so the capture exists.
  for (let attempt = 0; attempt < 40; attempt++) {
    const listing = await exec(`test -f ${directory}/stdout.capture && echo yes || echo no`);

    if (listing.stdout.trim() === "yes") break;
    await Bun.sleep(50);
  }

  expect(
    (
      await exec(
        `rm -f ${directory}/stdout.capture && ln -s /etc/hostname ${directory}/stdout.capture`,
      )
    ).statusCode,
  ).toBe(0);

  const observation = await pollProgress(owner);

  expect(observation.available).toBe(false);
  expect(observation.chunks).toHaveLength(0);
});

test("a tampered command metadata never authorizes a progress read", async () => {
  const owner = newCommandOwner({
    workspace: progressWorkspace("progress-metadata"),
    runId: "run-progress",
    attemptId: "attempt-progress",
  });

  const directory = `/tmp/cloud-swe-commands/${owner.workspace.id}/${owner.commandId}`;

  await fencedCommand(owner, "printf 'guarded'", 20_000);

  for (let attempt = 0; attempt < 40; attempt++) {
    const listing = await exec(`test -f ${directory}/metadata && echo yes || echo no`);

    if (listing.stdout.trim() === "yes") break;
    await Bun.sleep(50);
  }

  expect((await exec(`printf 'attemptId=other\n' > ${directory}/metadata`)).statusCode).toBe(0);

  const observation = await pollProgress(owner);

  expect(observation.available).toBe(false);
  expect(observation.chunks).toHaveLength(0);
});
