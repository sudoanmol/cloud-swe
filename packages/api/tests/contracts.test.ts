import { describe, expect, test } from "bun:test";

import { incrementalToolOutputSchema } from "@cloud-swe/db/tool-events";
import { workspaceResetPayloadSchema } from "@cloud-swe/db/pi-events";
import { threadSnapshotSchema, isoDateTimeSchema } from "../src/contracts";
import { validateKnownThreadEvent } from "../src/events";

describe("browser wire contracts", () => {
  test("rejects a non-ISO datetime", () => {
    expect(isoDateTimeSchema.safeParse("not-a-date").success).toBe(false);
    expect(isoDateTimeSchema.safeParse("2026-01-01T00:00:00.000Z").success).toBe(true);
  });

  test("accepts the explicit public snapshot projection", () => {
    const snapshot = {
      id: "22222222-2222-4222-8222-222222222222",
      userId: "user-1",
      title: null,
      repositoryUrl: null,
      repositoryBranch: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          runId: "11111111-1111-4111-8111-111111111111",
          role: "user",
          content: "hello",
          clientMessageId: "message-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          attachments: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              filename: "notes.txt",
              detectedMimeType: "text/plain",
              classification: "file",
              size: 12,
              modelMimeType: null,
              modelSize: null,
              modelWidth: null,
              modelHeight: null,
            },
          ],
        },
      ],
      runs: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          status: "running",
          prompt: "hello",
          modelSelection: {
            provider: "openrouter",
            model: "anthropic/claude",
            thinkingLevel: "medium",
          },
          cancelRequestedAt: null,
          approvalWaitStartedAt: null,
          questionWaitStartedAt: "2026-01-01T00:01:00.000Z",
          startedAt: null,
          completedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          error: null,
        },
      ],
      workspace: {
        id: "55555555-5555-4555-8555-555555555555",
        state: "running",
        provider: "docker",
        generation: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      environment: {
        id: "66666666-6666-4666-8666-666666666666",
        name: "development",
        revisionNumber: 1,
        revisionCreatedAt: "2026-01-01T00:00:00.000Z",
        latestRevisionNumber: 2,
      },
      latestEventId: 7,
    };

    expect(threadSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  test("serializes the real workspace.reset payload shape", () => {
    expect(
      workspaceResetPayloadSchema.safeParse({
        threadId: "22222222-2222-4222-8222-222222222222",
        workspaceId: "55555555-5555-4555-8555-555555555555",
        oldGeneration: 1,
        newGeneration: 2,
        reason: "provider-missing",
        resetTransitionId: null,
        unsettledOlderOperations: 0,
        confirmedMissing: true,
        message: "The workspace filesystem was replaced.",
      }).success,
    ).toBe(true);
    // A reset is not a workspace state transition and must not require `state`.
    expect(workspaceResetPayloadSchema.safeParse({ threadId: "t", state: "running" }).success).toBe(
      false,
    );
  });

  test("validates known payloads and leaves unknown events alone", () => {
    expect(() =>
      validateKnownThreadEvent({
        sequence: 1,
        type: "assistant.delta",
        payload: { runId: "r", attemptId: "a", assistantAttempt: 1, deltaIndex: 0 },
      }),
    ).not.toThrow();
    expect(() =>
      validateKnownThreadEvent({
        sequence: 2,
        type: "assistant.delta",
        payload: { nope: true },
      }),
    ).toThrow();
    expect(() =>
      validateKnownThreadEvent({
        sequence: 3,
        type: "future.event",
        payload: { anything: true },
      }),
    ).not.toThrow();
  });

  test("accepts the live incremental tool.output variant", () => {
    expect(
      incrementalToolOutputSchema.safeParse({
        toolCallId: "call-1",
        incremental: true,
        stream: "stdout",
        offset: 0,
        text: "partial\n",
      }).success,
    ).toBe(true);
    expect(
      incrementalToolOutputSchema.safeParse({ toolCallId: "call-1", offset: 0, text: "x" }).success,
    ).toBe(false);
  });
});
