import { describe, expect, test } from "bun:test";

import { applyRunLifecycleEvent, type ThreadSnapshot } from "../src/client";

const runId = "11111111-1111-4111-8111-111111111111";

function snapshot(status: ThreadSnapshot["runs"][number]["status"]): ThreadSnapshot {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    userId: "user-1",
    title: null,
    repositoryUrl: null,
    repositoryBranch: null,
    messages: [],
    runs: [
      {
        id: runId,
        status,
        prompt: "start the workspace",
        cancelRequestedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        error: null,
      },
    ],
    workspace: null,
    latestEventId: 1,
  };
}

function hasActiveRun(view: ThreadSnapshot): boolean {
  return view.runs.some((run) => run.status === "queued" || run.status === "running");
}

describe("thread snapshot run lifecycle", () => {
  test("terminal run events clear the active run used for cancel", () => {
    const queued = snapshot("queued");
    expect(hasActiveRun(queued)).toBe(true);

    const cancelled = applyRunLifecycleEvent(queued, {
      sequence: 4,
      type: "run.cancelled",
      payload: { runId },
    });
    expect(cancelled.runs[0]?.status).toBe("cancelled");
    expect(hasActiveRun(cancelled)).toBe(false);

    const completed = applyRunLifecycleEvent(snapshot("running"), {
      sequence: 5,
      type: "run.completed",
      payload: { runId },
    });
    expect(completed.runs[0]?.status).toBe("completed");
    expect(hasActiveRun(completed)).toBe(false);
  });

  test("started events mark the matching run running", () => {
    const next = applyRunLifecycleEvent(snapshot("queued"), {
      sequence: 2,
      type: "run.started",
      payload: { runId },
    });
    expect(next.runs[0]?.status).toBe("running");
    expect(hasActiveRun(next)).toBe(true);
  });

  test("ignores non-lifecycle events and unknown run ids", () => {
    const current = snapshot("running");
    expect(
      applyRunLifecycleEvent(current, {
        sequence: 3,
        type: "assistant.delta",
        payload: { runId, delta: "hi" },
      }),
    ).toBe(current);
    expect(
      applyRunLifecycleEvent(current, {
        sequence: 4,
        type: "run.cancelled",
        payload: { runId: "33333333-3333-4333-8333-333333333333" },
      }),
    ).toBe(current);
  });
});
