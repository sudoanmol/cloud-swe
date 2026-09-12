import { expect, spyOn, test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createPiModelRuntime } from "../src/pi";

test("Pi reads the selected user's current key on each request, without ambient fallback", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "worker-secret";

  try {
    const credentials = new InMemoryCredentialStore();
    const runtime = await createPiModelRuntime(credentials, "openrouter");
    expect(await runtime.getAuth("openrouter")).toBeUndefined();
    await credentials.modify("openrouter", async () => ({ type: "api_key", key: "user-first" }));
    expect((await runtime.getAuth("openrouter"))?.auth.apiKey).toBe("user-first");
    await credentials.modify("openrouter", async () => ({ type: "api_key", key: "user-second" }));
    expect((await runtime.getAuth("openrouter"))?.auth.apiKey).toBe("user-second");
    await credentials.delete("openrouter");
    expect(await runtime.getAuth("openrouter")).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("Pi refreshes expired ChatGPT tokens once and saves the rotated credential", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: "expired",
    refresh: "refresh-first",
    expires: 0,
    accountId: "account",
  }));
  const runtime = await createPiModelRuntime(credentials, "openai-codex");
  const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        url: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        expect(String(url)).toBe("https://auth.openai.com/oauth/token");
        expect(String(init?.body)).toContain("refresh-first");

        return Response.json({
          access_token: access,
          refresh_token: "refresh-second",
          expires_in: 3600,
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  try {
    const auth = await Promise.all([
      runtime.getAuth("openai-codex"),
      runtime.getAuth("openai-codex"),
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth.map((result) => result?.auth.apiKey)).toEqual([access, access]);
    expect(await credentials.read("openai-codex")).toMatchObject({
      access,
      refresh: "refresh-second",
    });
  } finally {
    fetch.mockRestore();
  }
});
