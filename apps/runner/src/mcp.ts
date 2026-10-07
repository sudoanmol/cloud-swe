import {
  createMcpExtension,
  type ExtensionFactory,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import {
  StreamableHttpTransport,
  parseJsonRpcMessage,
  type McpTransportMessageListener,
  type McpTransportErrorListener,
  type JsonRpcMessage,
} from "@earendil-works/pi-mcp";
import type { ComposioMcp } from "@cloud-swe/db/composio";
import { jsonValueSchema, type JsonValue } from "@cloud-swe/db/json";
import { z } from "zod";
import { mcpToolResultSchema } from "@cloud-swe/db/tool-events";
import { boundedUtf8 } from "./text.js";

/** Also catches headers echoed inside JSON error bodies, before SDK temp files or hooks. */
export function redactMcpValue(value: JsonValue, secrets: readonly string[]): JsonValue {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Values are parsed JSON; recurse over the JSON union to redact echoed secrets.
  if (typeof value === "string") {
    for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[redacted]");

    return value;
  }

  if (Array.isArray(value)) return value.map((item) => redactMcpValue(item, secrets));

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Parsed JSON object branch after strings and arrays.
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        String(redactMcpValue(key, secrets)),
        redactMcpValue(item, secrets),
      ]),
    );

  return value;
}

class ComposioTransport extends StreamableHttpTransport {
  constructor(mcp: ComposioMcp) {
    super({
      url: mcp.url,
      headers: mcp.headers,
      maxMessageBytes: 4_194_304,
      // Never forward project credentials through redirects or ambient Pi OAuth.
      fetch: async (url, init) => {
        if (new URL(String(url)).origin !== new URL(mcp.url).origin)
          throw new Error("MCP request failed");

        try {
          return await fetch(url, { ...init, redirect: "error" });
        } catch {
          throw new Error("MCP request failed");
        }
      },
    });
    this.secrets = Object.values(mcp.headers);
  }
  private readonly secrets: string[];
  override async send(message: JsonRpcMessage) {
    try {
      await super.send(message);
    } catch {
      throw new Error("MCP request failed");
    }
  }
  override onError(listener: McpTransportErrorListener) {
    return super.onError(() => listener(new Error("MCP request failed")));
  }
  override onMessage(listener: McpTransportMessageListener) {
    return super.onMessage((message) => {
      // JSON-RPC is validated by the transport, then again by Pi's client.
      const safe = parseJsonRpcMessage(
        redactMcpValue(jsonValueSchema.parse(message), this.secrets),
      );

      listener(safe);
    });
  }
}

/** Shared byte budget for model output, checkpoints, and the public tool card. */
export function projectMcpResult(
  toolName: string,
  content: AgentToolResult<unknown>["content"],
  maxBytes: number,
) {
  let remaining = maxBytes;
  let truncated = false;

  const bounded = content.flatMap((block) => {
    if (block.type === "text") {
      const part = boundedUtf8(block.text, remaining);
      remaining -= Buffer.byteLength(part.text);
      truncated ||= part.truncated;

      return part.text ? [{ type: "text" as const, text: part.text }] : [];
    }

    const parsed = mcpToolResultSchema.shape.content.element.safeParse(block);

    if (!parsed.success || Buffer.byteLength(block.data) > remaining) {
      truncated = true;

      return [];
    }

    remaining -= Buffer.byteLength(block.data);

    return [parsed.data];
  });

  return mcpToolResultSchema.parse({
    kind: "mcp",
    server: "composio",
    tool: toolName.slice("mcp__composio__".length),
    content: bounded,
    truncated,
  });
}

export function composioExtensionFactories(
  mcp: ComposioMcp,
  maxBytes: number,
  blockReason?: () => string | undefined,
): ExtensionFactory[] {
  return [
    createMcpExtension({
      loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
      logPath: "/dev/null",
      createTransport: () => new ComposioTransport(mcp),
    }),
    (pi) => {
      pi.registerMcpServer("composio", {
        url: mcp.url,
        // Suppress Pi OAuth discovery. The transport sends only the original SDK headers.
        headers: { ...mcp.headers, Authorization: "" },
        exposure: "direct",
      });
      pi.on("tool_call", (event) => {
        if (!event.toolName.startsWith("mcp__composio__")) return;
        const reason = blockReason?.();

        if (reason) return { block: true, reason };
      });
      pi.on("tool_result", (event) => {
        if (!event.toolName.startsWith("mcp__composio__")) return;

        const safeContent = event.isError
          ? [
              {
                type: "text" as const,
                text: "MCP tool failed. Try again or reconnect the toolkit.",
              },
            ]
          : event.content.map((block) =>
              block.type === "text"
                ? { ...block, text: String(redactMcpValue(block.text, Object.values(mcp.headers))) }
                : block,
            );

        const result = projectMcpResult(event.toolName, safeContent, maxBytes);

        // Replacing content also drops raw structuredContent; details become our public projection.
        return { content: result.content, details: result, isError: event.isError };
      });
    },
  ];
}

const sdkMcpResultSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
    ]),
  ),
  details: z.unknown().optional(),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate SDK tool results at the durable event boundary.
export function mcpEventResult(
  name: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK results are parsed immediately below.
  value: unknown,
  isError: boolean,
  maxBytes: number,
  secrets: readonly string[],
) {
  if (!name.startsWith("mcp__composio__")) return null;
  const parsed = sdkMcpResultSchema.safeParse(value);
  const details = parsed.success ? mcpToolResultSchema.safeParse(parsed.data.details) : undefined;

  const content =
    isError || !parsed.success
      ? [{ type: "text" as const, text: "MCP tool failed. Try again or reconnect the toolkit." }]
      : parsed.data.content.map((block) =>
          block.type === "text"
            ? { ...block, text: String(redactMcpValue(block.text, secrets)) }
            : block,
        );

  const result = projectMcpResult(name, content, maxBytes);

  if (details?.success) {
    result.tool = details.data.tool;
    result.truncated ||= details.data.truncated;
  }

  return result;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK arguments are untrusted JSON; bound their public projection.
export function mcpEventArguments(value: unknown, maxBytes: number, secrets: readonly string[]) {
  const safe = redactMcpValue(jsonValueSchema.parse(value), secrets);
  const preview = boundedUtf8(JSON.stringify(safe), maxBytes);

  return preview.truncated ? { preview: preview.text, truncated: true } : safe;
}
