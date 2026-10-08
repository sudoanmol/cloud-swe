import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { z } from "zod";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { decodeLivePiSessionEntries, decodePiSessionCheckpoint } from "@cloud-swe/db/checkpoint";
import type { ContextCompactedPayload } from "@cloud-swe/db/pi-events";
import { createPiExecutor, type PiPersistedSessionMetadata } from "../src/pi.js";
import { processResult } from "../src/sandbox.js";

for (const overflow of [false, true]) {
  test(`real Pi ${overflow ? "overflow recovery" : "threshold compaction"} checkpoints and resumes`, async () => {
    let summaries = 0;
    let replies = 0;
    const requests: string[] = [];

    const server = createServer(async (request, response) => {
      const chunks = [];

      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();

      requests.push(body);
      expect(request.headers.authorization).toBe("Bearer user-test-key");
      const summarizing = body.includes("You are a context summarization assistant.");

      if (!summarizing && overflow && replies++ === 0) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "context_length_exceeded",
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          }),
        );

        return;
      }

      if (summarizing) summaries++;
      const content = summarizing ? "Saved goal: finish the task. Prior work summarized." : "done";

      if (JSON.parse(body).stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "test",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
        );
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = z.object({ port: z.number() }).parse(server.address());

    const runtime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
      credentials: {
        read: async () => ({ type: "api_key", key: "user-test-key" }),
        list: async () => [],
        modify: async (_provider, update) => update(undefined),
        delete: async () => undefined,
      },
    });

    runtime.registerProvider("compaction-test", {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "user-test-key",
      models: [
        {
          id: "small",
          name: "small",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 40_000,
          maxTokens: 1000,
        },
      ],
    });
    const manager = SessionManager.inMemory("/workspace");

    for (let index = 0; index < 8; index++) {
      manager.appendMessage({
        role: "user",
        content: "old history " + "x".repeat(14_000),
        timestamp: 1,
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Prior work" }],
        api: "openai-completions",
        provider: "compaction-test",
        model: "small",
        timestamp: 2,
        stopReason: "stop",
        usage: {
          input: overflow ? 3000 : 30000,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: overflow ? 3010 : 30010,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
    }

    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Prior work" }],
      api: "openai-completions",
      provider: "compaction-test",
      model: "small",
      timestamp: 2,
      stopReason: "stop",
      usage: {
        input: overflow ? 3000 : 30000,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: overflow ? 3010 : 30010,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const header = manager.getHeader();

    if (!header) throw new Error("Missing session header");
    const checkpoints: PiPersistedSessionMetadata[] = [];
    const compactions: ContextCompactedPayload[] = [];

    const executor = (attemptId: string) =>
      createPiExecutor(
        {
          piProvider: "compaction-test",
          piModel: "small",
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
          checkpoint: async (metadata, _proposal, _questions, compaction) => {
            expect(metadata).toMatchObject({ attemptId, workspaceGeneration: 1 });
            checkpoints.push(metadata);

            if (compaction) compactions.push(compaction);
          },
        },
        {
          createAgentSession: (options) =>
            createAgentSession({
              ...options,
              modelRuntime: runtime,
              model: runtime.getModel("compaction-test", "small"),
            }),
        },
      );

    try {
      const result = await executor("first")({
        prompt: "Finish",
        runId: "run",
        attemptId: "first",
        workspaceGeneration: 1,
        sessionEntries: [header, ...manager.getEntries()],
        signal: AbortSignal.timeout(15000),
      });

      expect(result.text).toBe("done");
      expect(summaries).toBeGreaterThan(0);
      expect(compactions).toHaveLength(1);
      expect(compactions[0]?.reason).toBe(overflow ? "overflow" : "threshold");

      const checkpoint = checkpoints.find((checkpoint) =>
        checkpoint.entries.some((entry) => entry.type === "compaction"),
      );

      if (!checkpoint) throw new Error("No compaction checkpoint");
      expect(
        checkpoint.entries.some(
          (entry) => entry.type === "message" && entry.message.role === "user",
        ),
      ).toBe(true);
      const decoded = decodePiSessionCheckpoint(checkpoint);

      const restored = SessionManager.inMemory(
        "/workspace",
        undefined,
        decodeLivePiSessionEntries(decoded.entries),
      );

      expect(
        restored
          .buildSessionContext()
          .messages.some((message) => message.role === "compactionSummary"),
      ).toBe(true);
      const beforeResume = requests.length;
      await executor("resumed")({
        prompt: "Continue",
        runId: "run",
        attemptId: "resumed",
        workspaceGeneration: 1,
        sessionEntries: decodeLivePiSessionEntries(result.session.entries),
        signal: AbortSignal.timeout(15000),
      });
      expect(requests[beforeResume]).toContain("Saved goal");
      expect(requests[beforeResume]?.length).toBeLessThan(112_000);
      expect(compactions).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);
}
