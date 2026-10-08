import { expect, test } from "bun:test";
import pino from "pino";
import { loadRunnerConfig } from "../src/config.js";
import { createModalProvider } from "../src/modal.js";
import type { WorkspaceRef } from "../src/sandbox.js";

test("guest commands reuse one Modal handle until a transport failure", async () => {
  const lookups: string[] = [];
  const detached: string[] = [];
  const stdinWrites: string[] = [];
  let failNext = false;

  const handle = (sandboxId: string) => ({
    sandboxId,
    detach: () => detached.push(sandboxId),
    exec: async () => {
      if (failNext) {
        failNext = false;
        throw new Error("stream reset");
      }

      return {
        stdin: { writeText: async (text: string) => stdinWrites.push(text), close: async () => {} },
        stdout: { readText: async () => "ok" },
        stderr: { readText: async () => "" },
        wait: async () => 0,
      };
    },
  });

  const client = {
    sandboxes: {
      fromId: async (id: string) => {
        lookups.push(id);

        return handle(id);
      },
    },
  };

  const config = loadRunnerConfig();

  const provider = createModalProvider(
    {
      ...config,
      sandboxProvider: "modal",
      modal: {
        tokenId: "test",
        tokenSecret: "test",
        environment: "test",
        appName: "test",
        imageName: "test",
        sandboxLimit: 4,
        maxRunSeconds: 3600,
      },
    },
    pino({ enabled: false }),
    // SAFETY: exec only calls sandboxes.fromId and the handle methods faked above.
    { client: client as never },
  );

  const workspace: WorkspaceRef = {
    id: "workspace",
    threadId: "thread",
    name: "cloud-swe-test",
    provider: "modal",
    providerId: "sb-1",
    generation: 1,
  };

  const signal = new AbortController().signal;
  const run = (stdin?: string) => provider.exec(workspace, { command: "true", stdin }, signal);

  expect(await run("")).toMatchObject({ kind: "completed", stdout: "ok" });
  expect(await run("input")).toMatchObject({ kind: "completed" });
  expect(lookups).toEqual(["sb-1"]);
  // An empty stdin is delivered by EOF alone.
  expect(stdinWrites).toEqual(["input"]);

  failNext = true;
  expect(await run()).toMatchObject({ kind: "unknown" });
  expect(detached).toEqual(["sb-1"]);

  await run();
  expect(lookups).toEqual(["sb-1", "sb-1"]);
});
