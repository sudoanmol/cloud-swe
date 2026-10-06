import { expect, test } from "bun:test";

import { readRelayCapability, relayUrl, signRelayCapability } from "../src/browser-relay";

const secret = "a".repeat(32);

const capability = {
  threadId: "00000000-0000-4000-8000-000000000001",
  generation: 2,
  expires: 2_000,
};

test("verifies a signed capability until it expires", () => {
  const token = signRelayCapability(secret, capability);

  expect(readRelayCapability(secret, token, 1_000)).toEqual(capability);
  expect(readRelayCapability(secret, token, 2_000)).toBeNull();
  expect(new URL(relayUrl("wss://gateway.test/cdp", token)).searchParams.get("cap")).toBe(token);
});

test("rejects forged and malformed capabilities", () => {
  const token = signRelayCapability(secret, capability);
  const [payload, signature] = token.split(".");

  const forged = Buffer.from(JSON.stringify({ ...capability, generation: 3 })).toString(
    "base64url",
  );

  expect(readRelayCapability("b".repeat(32), token, 1_000)).toBeNull();
  expect(readRelayCapability(secret, `${forged}.${signature}`, 1_000)).toBeNull();
  expect(readRelayCapability(secret, `${payload}.${signature}.x`, 1_000)).toBeNull();
  expect(readRelayCapability(secret, "nonsense", 1_000)).toBeNull();
});
