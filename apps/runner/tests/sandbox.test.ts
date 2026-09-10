import { expect, test } from "bun:test";
import {
  remainingProviderTimeoutMs,
  SandboxProviderError,
  withProviderBudget,
} from "../src/sandbox.js";

test("SandboxProviderError preserves the provided cause", () => {
  const cause = new Error("docker inspect failed");
  const error = new SandboxProviderError("unknown", "docker inspect", "failed", { cause });
  expect(error.cause).toBe(cause);
});

test("remainingProviderTimeoutMs never goes below one millisecond", () => {
  expect(remainingProviderTimeoutMs(Date.now() + 5_000, Date.now())).toBeGreaterThan(1);
  expect(remainingProviderTimeoutMs(1_000, 5_000)).toBe(1);
});

test("withProviderBudget aborts after the public provider timeout", async () => {
  const start = Date.now();
  const signal = withProviderBudget(new AbortController().signal, 40);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("budget did not abort")), 500);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  expect(Date.now() - start).toBeLessThan(400);
});

test("withProviderBudget forwards an already-aborted caller signal", () => {
  const controller = new AbortController();
  controller.abort();
  expect(withProviderBudget(controller.signal, 5_000).aborted).toBe(true);
});
