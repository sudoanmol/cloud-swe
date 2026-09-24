import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

/**
 * `emptyStringAsUndefined` deletes every empty process env key, so a second
 * `loadRootEnv()` would resurrect the deleted keys from `.env` and silently
 * discard an explicit empty override. Each case runs in its own process because
 * both the dotenv load and the deletion happen once per import.
 */
const probePath = fileURLToPath(new URL("./fixtures/env-probe.ts", import.meta.url));

type Case = {
  name: string;
  env: Record<string, string>;
  expected: { url: string | null; secret: string | null; storage: string | null };
};

const fixtureSecret = "f".repeat(64);

const fixtureStorage = "/tmp/cloud-swe-git-broker-fixture";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cloud-swe-env-"));

  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cloud-swe-env-fixture" }));
  writeFileSync(join(root, "turbo.json"), "{}");
  writeFileSync(
    join(root, ".env"),
    `GIT_BROKER_URL=\nGIT_BROKER_SECRET=${fixtureSecret}\nGIT_BROKER_STORAGE=${fixtureStorage}\n`,
  );

  return root;
}

async function run(root: string, env: Record<string, string>) {
  // A clean environment: the parent inherits the repository `.env` from Bun's
  // own autoload, which would mask whether the probe read the fixture root.
  const child = Bun.spawn(["bun", "--no-env-file", probePath], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  await child.exited;

  if (child.exitCode !== 0) throw new Error(`env probe failed: ${stderr}`);

  return JSON.parse(stdout.trim());
}

// The control case proves the probe actually reads the fixture `.env`; without
// it the override case could pass because nothing was ever loaded.
const cases: Case[] = [
  {
    name: "reads the repository root .env once",
    env: {},
    expected: { url: null, secret: fixtureSecret, storage: fixtureStorage },
  },
  {
    name: "keeps explicit empty overrides disabled across env module imports",
    env: { GIT_BROKER_URL: "", GIT_BROKER_SECRET: "", GIT_BROKER_STORAGE: "" },
    expected: { url: null, secret: null, storage: null },
  },
];

for (const testCase of cases) {
  test(testCase.name, async () => {
    const root = fixtureRoot();

    try {
      expect(await run(root, testCase.env)).toEqual(testCase.expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
