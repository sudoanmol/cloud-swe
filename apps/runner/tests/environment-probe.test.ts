import { mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

// The environment probe the Pi activity runs before each attempt. A fake
// docker on PATH starts answering on its third call.
const program = await readFile(new URL("../src/guest/environment.py", import.meta.url), "utf8");

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cloud-swe-environment-"));
  await writeFile(
    join(root, "docker"),
    `#!/bin/sh\nn=$(cat "${root}/calls" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "${root}/calls"\n[ "$n" -ge 3 ]\n`,
  );
  await chmod(join(root, "docker"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function probe(stdin: { git: string | null; browser: string | null }, paths: string[]) {
  await rm(join(root, "calls"), { force: true });

  const child = Bun.spawn(["python3", "-c", program, ...paths], {
    stdin: new TextEncoder().encode(JSON.stringify(stdin)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
  });

  const [stdout, statusCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

  return { stdout, statusCode };
}

test("writes private Git and browser config, then reports Docker once it answers", async () => {
  const git = join(root, "lib", "git.config");
  const browser = join(root, "browser", "config.json");
  const result = await probe({ git: "[http]\n", browser: '{"cdp":"wss://relay"}' }, [git, browser]);

  expect(result.statusCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ browser: true, docker: true });
  expect(await readFile(git, "utf8")).toBe("[http]\n");
  expect(await readFile(browser, "utf8")).toBe('{"cdp":"wss://relay"}');
  expect((await stat(git)).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "lib"))).mode & 0o777).toBe(0o700);
});

test("a failed Git write fails the command; a failed browser write is only reported", async () => {
  const blocked = join(root, "blocked");
  await writeFile(blocked, "");

  const gitFailed = await probe({ git: "[http]\n", browser: null }, [
    join(blocked, "git.config"),
    join(root, "unused"),
  ]);

  expect(gitFailed.statusCode).not.toBe(0);

  const browserFailed = await probe({ git: null, browser: "{}" }, [
    join(root, "unused"),
    join(blocked, "config.json"),
  ]);

  expect(browserFailed.statusCode).toBe(0);
  expect(JSON.parse(browserFailed.stdout)).toMatchObject({ browser: false, docker: true });

  const nothing = await probe({ git: null, browser: null }, [
    join(root, "unused"),
    join(root, "unused"),
  ]);

  expect(JSON.parse(nothing.stdout)).toMatchObject({ browser: null, docker: true });
});

test("a branch name that is not UTF-8 is reported, not fatal", async () => {
  // Git accepts these bytes in a branch name; the fake git prints one.
  await writeFile(join(root, "git"), "#!/bin/sh\nprintf 'feature/\\377\\n'\n");
  await chmod(join(root, "git"), 0o755);

  try {
    const result = await probe({ git: "[http]\n", browser: null }, [
      join(root, "lib", "git.config"),
      join(root, "unused"),
    ]);

    expect(result.statusCode).toBe(0);
    expect(JSON.parse(result.stdout).branch).toBe("feature/\uFFFD");
  } finally {
    await rm(join(root, "git"));
  }
});
