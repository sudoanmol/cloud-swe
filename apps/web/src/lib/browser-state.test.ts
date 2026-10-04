import { expect, test } from "bun:test";

import { ThreadApiError } from "@cloud-swe/api/client";

import { clearDraft, readDraft, writeDraft } from "./drafts";
import { errorCode, isRetryable, messageForError } from "./submission-errors";

type SessionStorageStub = Pick<Storage, "getItem" | "removeItem" | "setItem"> & {
  readonly values: Map<string, string>;
};

/** Minimal sessionStorage stub so the draft store can be exercised off-browser. */
function withSessionStorage(): SessionStorageStub {
  const values = new Map<string, string>();

  const stub: SessionStorageStub = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
    values,
  };

  const globals: { window?: unknown } = globalThis;

  globals.window = { sessionStorage: stub };

  return stub;
}

test("drafts are isolated by account and by thread key", () => {
  const { values } = withSessionStorage();

  writeDraft("user-a", "new-thread", "hello");
  writeDraft("user-b", "new-thread", "other");
  writeDraft("user-a", "thread:1", "in-thread");

  expect(readDraft("user-a", "new-thread")).toBe("hello");
  expect(readDraft("user-b", "new-thread")).toBe("other");
  expect(readDraft("user-a", "thread:1")).toBe("in-thread");
  expect(readDraft("user-a", "thread:2")).toBe("");

  clearDraft("user-a", "new-thread");
  expect(readDraft("user-a", "new-thread")).toBe("");
  expect(readDraft("user-b", "new-thread")).toBe("other");

  writeDraft("user-a", "thread:1", "");
  expect(values.has("cloud-swe:draft:user-a:thread:1")).toBe(false);
});

test("drafts degrade quietly without a browser storage", () => {
  const globals: { window?: unknown } = globalThis;

  delete globals.window;

  writeDraft("user-a", "new-thread", "hello");
  expect(readDraft("user-a", "new-thread")).toBe("");
});

test("error messages map known codes and keep the server text otherwise", () => {
  expect(messageForError(new ThreadApiError(409, "THREAD_BUSY", "busy"))).toMatch(/active run/i);
  expect(messageForError(new ThreadApiError(409, "SOMETHING_NEW", "Server said so"))).toBe(
    "Server said so",
  );
  expect(messageForError(new TypeError("fetch failed"))).toMatch(/unreachable/i);
  expect(errorCode(new ThreadApiError(500, "CREATE_FAILED", "x"))).toBe("CREATE_FAILED");
  expect(errorCode(new Error("local"))).toBeNull();
});

test("only transient failures are retryable", () => {
  expect(isRetryable(new ThreadApiError(429, "RATE_LIMITED", "slow down"))).toBe(true);
  expect(isRetryable(new ThreadApiError(503, "ADMISSION_UNAVAILABLE", "later"))).toBe(true);
  expect(isRetryable(new ThreadApiError(403, "ONBOARDING_REQUIRED", "finish setup"))).toBe(false);
  expect(isRetryable(new ThreadApiError(400, "INVALID_PAYLOAD", "bad"))).toBe(false);
  expect(isRetryable(new TypeError("network"))).toBe(true);
});
