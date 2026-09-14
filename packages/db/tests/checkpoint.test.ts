/* oxlint-disable anti-slop/require-readable-spacing -- Decoder compatibility cases are table-like fixtures. */

import { describe, expect, test } from "bun:test";
import {
  decodePiSessionCheckpoint,
  decodeStoredPiSessionCheckpoint,
  InvalidPiCheckpointError,
} from "../src/checkpoint";

const header = {
  type: "session" as const,
  version: 3,
  id: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/workspace",
};

const valid = {
  version: 1 as const,
  sessionId: "session-1",
  provider: "test-provider",
  model: "test-model",
  entries: [header],
};

describe("versioned Pi checkpoint decoder", () => {
  test("decodes current inline and separate-entry formats", () => {
    const decoded = decodePiSessionCheckpoint(valid);
    expect(decoded).toMatchObject(valid);

    expect(
      decodeStoredPiSessionCheckpoint(
        { version: 1, sessionId: valid.sessionId, provider: valid.provider, model: valid.model },
        [header],
        1,
      ),
    ).toMatchObject(valid);
  });

  test("accepts every installed Pi session entry variant", () => {
    const base = { ...valid, entries: [header] };

    const entries = [
      header,
      {
        type: "message" as const,
        id: "user-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user" as const, content: "hello", timestamp: 1 },
      },
      {
        type: "message" as const,
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "hi", textSignature: "sig-text" },
            {
              type: "thinking" as const,
              thinking: "plan",
              thinkingSignature: "sig-think",
              redacted: true,
            },
          ],
          api: "test",
          provider: "test",
          model: "test",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: 2,
        },
      },
      {
        type: "message" as const,
        id: "tool-1",
        parentId: "assistant-1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult" as const,
          toolCallId: "call-1",
          toolName: "test",
          content: [{ type: "text" as const, text: "ok" }],
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message" as const,
        id: "bash-1",
        parentId: "tool-1",
        timestamp: "2026-01-01T00:00:03.500Z",
        message: {
          role: "bashExecution" as const,
          command: "echo ok",
          output: "ok",
          exitCode: undefined,
          cancelled: false,
          truncated: false,
          fullOutputPath: "/tmp/output",
          excludeFromContext: true,
          timestamp: 3.5,
        },
      },
      {
        type: "thinking_level_change" as const,
        id: "thinking-1",
        parentId: "bash-1",
        timestamp: "2026-01-01T00:00:04.000Z",
        thinkingLevel: "high",
      },
      {
        type: "model_change" as const,
        id: "model-1",
        parentId: "thinking-1",
        timestamp: "2026-01-01T00:00:05.000Z",
        provider: "test",
        modelId: "test-model",
      },
      {
        type: "compaction" as const,
        id: "compaction-1",
        parentId: "model-1",
        timestamp: "2026-01-01T00:00:06.000Z",
        summary: "summary",
        firstKeptEntryId: "user-1",
        tokensBefore: 3,
      },
      {
        type: "branch_summary" as const,
        id: "branch-1",
        parentId: "compaction-1",
        timestamp: "2026-01-01T00:00:07.000Z",
        fromId: "user-1",
        summary: "branch",
      },
      {
        type: "custom" as const,
        id: "custom-1",
        parentId: "branch-1",
        timestamp: "2026-01-01T00:00:08.000Z",
        customType: "test",
        data: { ok: true },
      },
      {
        type: "custom_message" as const,
        id: "custom-message-1",
        parentId: "custom-1",
        timestamp: "2026-01-01T00:00:09.000Z",
        customType: "test",
        content: "message",
        display: true,
      },
      {
        type: "label" as const,
        id: "label-1",
        parentId: "custom-message-1",
        timestamp: "2026-01-01T00:00:10.000Z",
        targetId: "user-1",
        label: "important",
      },
      {
        type: "session_info" as const,
        id: "info-1",
        parentId: "label-1",
        timestamp: "2026-01-01T00:00:11.000Z",
        name: "test session",
      },
    ];

    expect(decodePiSessionCheckpoint({ ...base, entries })).toMatchObject({ entries });
  });

  test("rejects missing and duplicate IDs, invalid variants, and broken references", () => {
    const cases = [
      { ...valid, entries: [{ ...header, id: "" }] },
      { ...valid, entries: [header, { ...header }] },
      { ...valid, entries: [{ ...header, type: "unknown" }] },
      {
        ...valid,
        entries: [
          header,
          {
            type: "message" as const,
            id: "message-1",
            parentId: "missing",
            timestamp: "2026-01-01T00:00:01.000Z",
            message: { role: "user" as const, content: "hello", timestamp: 1 },
          },
        ],
      },
    ];

    for (const value of cases)
      expect(() => decodePiSessionCheckpoint(value)).toThrow(InvalidPiCheckpointError);
  });

  test("rejects unsupported versions and malformed headers", () => {
    expect(() => decodePiSessionCheckpoint({ ...valid, version: 3 })).toThrow(
      InvalidPiCheckpointError,
    );
    expect(() =>
      decodePiSessionCheckpoint({ ...valid, entries: [{ ...header, timestamp: "bad" }] }),
    ).toThrow(InvalidPiCheckpointError);

    for (const version of [1, 2] as const) {
      expect(() =>
        decodePiSessionCheckpoint({ ...valid, entries: [{ ...header, version }] }),
      ).toThrow(InvalidPiCheckpointError);
    }

    const { version: _version, ...missingVersionHeader } = header;
    expect(() => decodePiSessionCheckpoint({ ...valid, entries: [missingVersionHeader] })).toThrow(
      InvalidPiCheckpointError,
    );
  });

  test("accepts attachment image references only in version 2", () => {
    const reference = {
      type: "attachment_image" as const,
      attachmentId: "11111111-1111-4111-8111-111111111111",
      variant: "model" as const,
      sha256: "a".repeat(64),
      mimeType: "image/webp" as const,
      size: 123,
    };
    const entries = [
      header,
      {
        type: "message" as const,
        id: "user-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user" as const, content: [reference], timestamp: 1 },
      },
    ];

    expect(decodePiSessionCheckpoint({ ...valid, version: 2, entries })).toMatchObject({
      version: 2,
      entries,
    });
    expect(() => decodePiSessionCheckpoint({ ...valid, version: 1, entries })).toThrow(
      InvalidPiCheckpointError,
    );
    expect(() =>
      decodePiSessionCheckpoint({
        ...valid,
        version: 2,
        entries: [
          header,
          {
            ...entries[1],
            message: { role: "user", content: [{ ...reference, sha256: "bad" }], timestamp: 1 },
          },
        ],
      }),
    ).toThrow(InvalidPiCheckpointError);
  });
});
