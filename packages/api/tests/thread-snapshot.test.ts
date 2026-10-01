import { describe, expect, test } from "bun:test";

import { threadSnapshotSchema, type ThreadSnapshot } from "../src/contracts";

const runId = "11111111-1111-4111-8111-111111111111";

function snapshot(status: ThreadSnapshot["runs"][number]["status"]): ThreadSnapshot {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    userId: "user-1",
    title: null,
    repositoryUrl: null,
    repositoryBranch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    runs: [
      {
        id: runId,
        status,
        prompt: "start the workspace",
        modelSelection: null,
        cancelRequestedAt: null,
        approvalWaitStartedAt: null,
        questionWaitStartedAt: null,
        startedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        error: null,
      },
    ],
    workspace: null,
    latestEventId: 1,
  };
}

describe("thread snapshot public shape", () => {
  test("parses the explicit public fields and no private keys", () => {
    const parsed = threadSnapshotSchema.parse(snapshot("queued"));

    expect(Object.keys(parsed).sort()).toEqual([
      "createdAt",
      "id",
      "latestEventId",
      "messages",
      "repositoryBranch",
      "repositoryUrl",
      "runs",
      "title",
      "updatedAt",
      "userId",
      "workspace",
    ]);
    expect(parsed.runs[0]?.status).toBe("queued");
    expect(parsed.runs[0]?.questionWaitStartedAt).toBeNull();
  });

  test("drops an unknown run field instead of leaking it", () => {
    const leaked = {
      ...snapshot("running"),
      runs: [{ ...snapshot("running").runs[0], ownerToken: "secret" }],
    };

    // Run objects are non-strict: extra fields are dropped, private ones are never selected.
    const parsed = threadSnapshotSchema.parse(leaked);

    expect("ownerToken" in (parsed.runs[0] ?? {})).toBe(false);
  });

  test("rejects a snapshot with an unknown run status", () => {
    const invalid = {
      ...snapshot("running"),
      runs: [{ ...snapshot("running").runs[0], status: "waiting" }],
    };

    expect(threadSnapshotSchema.safeParse(invalid).success).toBe(false);
  });
});
