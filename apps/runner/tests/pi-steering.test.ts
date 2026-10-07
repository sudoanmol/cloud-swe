import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { z } from "zod";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { decodeLivePiSessionEntries, decodePiSessionCheckpoint } from "@cloud-swe/db/checkpoint";
import { createPiExecutor } from "../src/pi.js";
import { processResult } from "../src/sandbox.js";

test("real Pi commits identical steers once across a failed checkpoint and attempt retry", async () => {
  const consumed: string[] = [];
  let checkpoint: ReturnType<typeof decodePiSessionCheckpoint> | undefined;
  let failSecond = true;
  const requests: string[] = [];

  const server = createServer(async (request, response) => {
    const chunks = [];

    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    requests.push(body);
    // The request containing a steer must follow its durable consumption commit.
    const steerCount = (body.match(/same steer/g) ?? []).length;
    expect(steerCount).toBeLessThanOrEqual(consumed.length);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());

  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => ({ type: "api_key", key: "user-key" }),
      list: async () => [],
      modify: async (_provider, update) => update(undefined),
      delete: async () => undefined,
    },
  });

  runtime.registerProvider("steering-test", {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    apiKey: "user-key",
    models: [
      {
        id: "test",
        name: "test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1000,
      },
    ],
  });

  const execute = createPiExecutor(
    {
      piProvider: "steering-test",
      piModel: "test",
      workspace: {
        id: "workspace",
        threadId: "thread",
        name: "test",
        provider: "docker",
        providerId: null,
        generation: 1,
      },
      sandbox: { exec: async () => processResult("", "", 0) },
      emit: async () => {},
      pendingSteers: async (offered) =>
        ["first", "second"].flatMap((id) =>
          !consumed.includes(id) && !offered.has(id)
            ? [{ id, text: "same steer", images: [], checkpointImages: [] }]
            : [],
        ),
      checkpoint: async (metadata, _proposal, _questions, _compaction, steers) => {
        if (steers?.[0]?.messageId === "second" && failSecond)
          throw new Error("checkpoint unavailable");

        for (const steer of steers ?? []) consumed.push(steer.messageId);
        checkpoint = decodePiSessionCheckpoint(metadata);
      },
    },
    {
      createAgentSession: (options) =>
        createAgentSession({
          ...options,
          modelRuntime: runtime,
          model: runtime.getModel("steering-test", "test"),
        }),
    },
  );

  const input = {
    prompt: "initial",
    runId: "run",
    workspaceGeneration: 1,
    signal: AbortSignal.timeout(15000),
  };

  try {
    await expect(execute({ ...input, attemptId: "first-attempt" })).rejects.toThrow(
      "checkpoint unavailable",
    );
    expect(consumed).toEqual(["first"]);

    if (!checkpoint) throw new Error("Missing durable checkpoint");
    expect(
      checkpoint.entries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          JSON.stringify(entry.message.content).includes("same steer"),
      ),
    ).toHaveLength(1);
    failSecond = false;

    const output = await execute({
      ...input,
      attemptId: "retry",
      sessionEntries: decodeLivePiSessionEntries(checkpoint.entries),
    });

    expect(output.text).toBe("done");
    expect(consumed).toEqual(["first", "second"]);
    expect(requests.at(-1)?.match(/same steer/g)).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
