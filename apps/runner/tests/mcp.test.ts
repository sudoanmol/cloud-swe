import { expect, test } from "bun:test";
import { z } from "zod";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiResourceLoader } from "../src/pi";
import { mcpEventResult, projectMcpResult } from "../src/mcp";

const secret = "composio-project-key";

test("real Pi MCP loads only our inline server, sends headers, and sanitizes results", async () => {
  const requests: string[] = [];
  let fail = false;
  const rpc = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string() });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push(request.headers.get("x-api-key") ?? "");

      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = rpc.parse(await request.json());

      if (message.id === undefined) return new Response(null, { status: 202 });

      if (fail && message.method === "tools/call") return new Response(secret, { status: 500 });

      let result;

      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "test-composio", version: "1" },
          };
          break;
        case "tools/list":
          result = {
            tools: [
              {
                name: "echo",
                description: "Echo documentation",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          };
          break;
        default:
          result = {
            content: [{ type: "text", text: `documentation ${secret}` }],
            _meta: { headers: { "x-api-key": secret } },
          };
      }

      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });

  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_provider, update) => update(undefined),
      delete: async () => undefined,
    },
  });

  let blockReason: string | undefined;

  const loader = createPiResourceLoader(
    undefined,
    undefined,
    { url: server.url.href, headers: { "x-api-key": secret } },
    1024,
    () => blockReason,
  );

  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().runtime.mcpServers.list()).toMatchObject([
    { name: "composio", config: { headers: { "x-api-key": secret }, exposure: "direct" } },
  ]);
  expect(loader.getSkills().skills).toEqual([]);
  expect(loader.getAgentsFiles().agentsFiles).toEqual([]);

  const { session } = await createAgentSession({
    cwd: "/workspace",
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
    sessionManager: SessionManager.inMemory("/workspace"),
    resourceLoader: loader,
    noTools: "builtin",
  });

  try {
    const failures: string[] = [];
    await session.bindExtensions({
      onError: (error) => {
        failures.push(error.error);
      },
    });
    const deadline = Date.now() + 3000;

    while (!session.getActiveToolNames().includes("mcp__composio__echo") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect({ tools: session.getActiveToolNames(), requests: requests.length, failures }).toEqual({
      tools: ["mcp__composio__echo"],
      requests: requests.length,
      failures: [],
    });
    const tool = session.agent.state.tools.find((tool) => tool.name === "mcp__composio__echo");

    if (!tool) throw new Error("MCP tool was not activated");
    blockReason = "Not executed: waiting for the pending Git approval.";
    expect(
      await session.extensionRunner.emitToolCall({
        type: "tool_call",
        toolName: tool.name,
        toolCallId: "blocked",
        input: {},
      }),
    ).toEqual({ block: true, reason: blockReason });
    blockReason = undefined;
    const result = await tool.execute("call", {}, new AbortController().signal);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.content).toEqual([{ type: "text", text: "documentation [redacted]" }]);

    const projected = await session.extensionRunner.emitToolResult({
      type: "tool_result",
      toolName: tool.name,
      toolCallId: "call",
      input: {},
      content: result.content,
      details: result.details,
      isError: false,
    });

    expect(projected?.details).toMatchObject({ kind: "mcp", server: "composio", tool: "echo" });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((key) => key === secret)).toBe(true);
    fail = true;
    await expect(tool.execute("failed", {}, new AbortController().signal)).rejects.toThrow(
      "MCP request failed",
    );
    expect(session.getActiveToolNames()).not.toContain("codemode");
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    server.stop(true);
  }

  const off = createPiResourceLoader();
  await off.reload();
  expect(off.getExtensions().runtime.mcpServers.list()).toEqual([]);
  expect(off.getExtensions().extensions).toEqual([]);
});

test("MCP errors drop SDK details and text/images share the output budget", () => {
  const error = mcpEventResult(
    "mcp__composio__echo",
    { content: [{ type: "text", text: secret }], details: { headers: { "x-api-key": secret } } },
    true,
    1000,
    [secret],
  );

  expect(JSON.stringify(error)).not.toContain(secret);

  const result = projectMcpResult(
    "mcp__composio__echo",
    [
      { type: "text", text: "世".repeat(20) },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ],
    16,
  );

  expect(result.truncated).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: "世".repeat(5) }]);
});
