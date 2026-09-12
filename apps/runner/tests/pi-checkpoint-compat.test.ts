import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { decodePiSessionCheckpoint } from "@cloud-swe/db/checkpoint";

test("validated project checkpoints initialize the installed Pi session manager", () => {
  const original = SessionManager.inMemory("/workspace");
  original.appendMessage({ role: "user", content: "Resume this task", timestamp: Date.now() });
  original.appendThinkingLevelChange("medium");
  original.appendModelChange("test-provider", "test-model");
  const header = original.getHeader();

  if (!header) throw new Error("Session manager did not create a header");

  const decoded = decodePiSessionCheckpoint({
    version: 1,
    sessionId: header.id,
    provider: "test-provider",
    model: "test-model",
    entries: [header, ...original.getEntries()],
  });

  const restored = SessionManager.inMemory("/workspace", undefined, decoded.entries);
  expect(restored.getHeader()?.id).toBe(header.id);
  expect(restored.buildSessionContext()).toEqual(original.buildSessionContext());
});

test("real Pi session builds its prompt from captured remote resources", async () => {
  const { createAgentSession, ModelRuntime, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");

  const { createPiResourceLoader } = await import("../src/pi.js");
  const { resolveRemoteResources } = await import("../src/remote-resources.js");

  const resources = resolveRemoteResources({
    entries: [],
    files: [
      {
        path: "/workspace/AGENTS.md",
        canonical: "/workspace/AGENTS.md",
        content: "Root scope instruction marker",
      },
      {
        path: "/workspace/nested/AGENTS.md",
        canonical: "/workspace/nested/AGENTS.md",
        content: "Nested scope instruction marker",
      },
    ],
  });

  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_provider, update) => update(undefined),
      delete: async () => undefined,
    },
    modelsPath: null,
    refreshOnCreate: false,
  });

  const { session } = await createAgentSession({
    cwd: "/workspace",
    modelRuntime,
    settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
    sessionManager: SessionManager.inMemory("/workspace"),
    noTools: "all",
    tools: [],
    customTools: [],
    resourceLoader: createPiResourceLoader(resources),
  });

  try {
    expect(session.systemPrompt).toContain("Root scope instruction marker");
    expect(session.systemPrompt).toContain("Nested scope instruction marker");
    expect(session.systemPrompt).toContain("directory /workspace/nested");
    expect(session.getActiveToolNames()).toEqual([]);
  } finally {
    session.dispose();
  }
});
