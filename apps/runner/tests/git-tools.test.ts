import { expect, test } from "bun:test";
import { createGitBrokerClient, createPiGitTools } from "../src/git-tools";
import { processResult } from "../src/sandbox";

test("concurrent readers share a complete access refresh and can retry a failed refresh", async () => {
  const installStarted = Promise.withResolvers<void>();
  const installation = Promise.withResolvers<void>();
  let requests = 0;
  let writes = 0;
  let fail = false;

  const git = createPiGitTools({
    client: {
      call: async () => {
        requests++;

        if (fail) throw new Error("Broker unavailable");

        return {
          repositoryUrl: "https://github.com/acme/repo.git",
          url: "https://broker.example/git/read",
          token: "read-capability",
          expires: Date.now() + 900_000,
        };
      },
    },
    exec: async () => {
      writes++;
      installStarted.resolve();
      await installation.promise;

      return processResult("", "", 0);
    },
    maxBytes: 1024,
    minFreeBytes: 0,
  });

  let completed = 0;

  const readers = Array.from({ length: 4 }, async () => {
    await git.refreshAccess();
    completed++;
  });

  try {
    await installStarted.promise;
    expect(requests).toBe(1);
    expect(writes).toBe(1);
    expect(completed).toBe(0);
  } finally {
    installation.resolve();
    await Promise.all(readers);
  }

  await git.refreshAccess();
  expect(requests).toBe(1);
  fail = true;
  const failures = await Promise.allSettled([git.refreshAccess(true), git.refreshAccess(true)]);
  expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(requests).toBe(2);
  fail = false;
  await git.refreshAccess(true);
  expect(requests).toBe(3);
  expect(writes).toBe(2);
});

test("the broker's secret refusal reaches the agent by variable name only", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { error: { code: "GIT_SECRET_DETECTED", message: "Not proposed: contains API_KEY" } },
        { status: 422 },
      ),
  });

  try {
    const client = createGitBrokerClient(
      { url: `http://127.0.0.1:${server.port}`, secret: "s" },
      { runId: crypto.randomUUID(), generation: 1, ownershipToken: crypto.randomUUID() },
      AbortSignal.timeout(5_000),
    );

    await expect(client.call("prepare")).rejects.toMatchObject({
      code: "GIT_SECRET_DETECTED",
      message: "Not proposed: contains API_KEY",
    });
  } finally {
    await server.stop(true);
  }
});
