import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * The sandbox's capability for the gateway's CDP relay: one thread's browser,
 * one filesystem generation, until the sandbox's hard timeout. The runner
 * signs it; the gateway verifies it and still checks the workspace is running.
 */
const relayCapabilitySchema = z
  .object({
    threadId: z.uuid(),
    generation: z.number().int().positive(),
    expires: z.number().int().positive(),
  })
  .strict();

export type RelayCapability = z.infer<typeof relayCapabilitySchema>;

/** agent-browser's user config; its `cdp` key makes every command use the relay. */
export const agentBrowserConfigPath = "/root/.agent-browser/config.json";

function sign(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signRelayCapability(secret: string, capability: RelayCapability): string {
  const payload = Buffer.from(JSON.stringify(relayCapabilitySchema.parse(capability))).toString(
    "base64url",
  );

  return `${payload}.${sign(secret, payload).toString("base64url")}`;
}

/** The verified capability, or null for a forged, malformed, or expired one. */
export function readRelayCapability(
  secret: string,
  token: string,
  now = Date.now(),
): RelayCapability | null {
  const [payload, signature, extra] = token.split(".");

  if (!payload || !signature || extra !== undefined) return null;
  const expected = sign(secret, payload);
  const supplied = Buffer.from(signature, "base64url");

  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const capability = relayCapabilitySchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );

    return capability.expires > now ? capability : null;
  } catch {
    return null;
  }
}

export function relayUrl(base: string, token: string): string {
  const url = new URL(base);
  url.searchParams.set("cap", token);

  return url.toString();
}
