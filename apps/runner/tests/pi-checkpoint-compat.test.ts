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
