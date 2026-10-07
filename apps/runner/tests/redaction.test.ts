import { expect, test } from "bun:test";
import { piSystemPrompt } from "../src/pi-system-prompt.js";
import { createRedactor, secretRedactor } from "../src/redaction.js";

test("replaces every exact occurrence, longest value first", () => {
  const redactor = createRedactor({ SHORT: "abcdefgh", LONG: "abcdefgh-ijkl" });

  expect(redactor.redact("x abcdefgh-ijkl y abcdefgh z")).toBe(
    "x [REDACTED:LONG] y [REDACTED:SHORT] z",
  );
});

test("plain entries stay visible", () => {
  const redactor = secretRedactor({
    entries: [
      { name: "KEY", secret: true },
      { name: "PORT", secret: false },
    ],
    values: { KEY: "sk-0123456789", PORT: "3000" },
  });

  expect(redactor.redact("KEY=sk-0123456789 PORT=3000")).toBe("KEY=[REDACTED:KEY] PORT=3000");
});

test("a value split across live chunks is held back until it is complete", () => {
  const live = createRedactor({ KEY: "sk-0123456789" }).stream();
  const chunks = ["start sk-01", "2345", "6789 end, more output here"];
  const emitted = chunks.map(live).join("");

  expect(emitted).not.toContain("sk-01");
  expect(emitted).toContain("start [REDACTED:KEY] end");
});

test("live output with every split point never leaks a value", () => {
  const value = "secret-value-123";
  const text = `a ${value} b ${value}${value} c`;

  for (let split = 0; split <= text.length; split++) {
    const live = createRedactor({ KEY: value }).stream();
    const emitted = live(text.slice(0, split)) + live(text.slice(split)) + live("x".repeat(64));

    expect(emitted).not.toContain("secret-value");
    expect(emitted.startsWith("a [REDACTED:KEY] b [REDACTED:KEY][REDACTED:KEY] c")).toBe(true);
  }
});

test("the system prompt lists variable names and explains the placeholder", () => {
  const prompt = piSystemPrompt(
    {
      id: "workspace",
      threadId: "thread",
      name: "test",
      provider: "docker",
      providerId: null,
      generation: 1,
    },
    ["bash"],
    1024,
    {
      repositoryUrl: null,
      branch: null,
      executionLimitMs: 1000,
      variables: [{ name: "API_KEY", secret: true }],
    },
  );

  expect(prompt).toContain('"variables":[{"name":"API_KEY","secret":true}]');
  expect(prompt).toContain("[REDACTED:NAME]");
});
