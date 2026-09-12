import { z } from "zod";
import { expect, spyOn, test } from "bun:test";
import Fastify from "fastify";
import { InMemoryCredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import { registerApiRoutes } from "../src/routes";
import { modelProviderSchema, modelProviders } from "@cloud-swe/db/model-selection";

const headers = { origin: "https://web.example.test", "x-csrf-protection": "1", "x-user": "alice" };

async function appForModels() {
  const credentials = new Map<string, InMemoryCredentialStore>();

  const credentialsFor = (id: string) => {
    let store = credentials.get(id);

    if (!store) {
      store = new InMemoryCredentialStore();
      credentials.set(id, store);
    }

    return store;
  };

  const app = Fastify();
  registerApiRoutes(app, {
    auth: {
      getSession: async (request) => {
        const id = request.get("x-user");

        return id ? { user: { id }, session: {} } : null;
      },
      handler: async () => Response.json({}),
    },
    store: {
      listThreads: async () => [],
      submitThread: async () => {
        throw new Error("Unexpected submission");
      },
      submitMessage: async () => {
        throw new Error("Unexpected submission");
      },
      getThread: async () => {
        throw new Error("Unexpected snapshot");
      },
      authorizeThread: async () => undefined,
      listEvents: async () => [],
      requestCancel: async () => undefined,
    },
    trustedOrigins: [headers.origin],
    modelCredentials: credentialsFor,
    requireModelSelection: true,
  });
  await app.ready();

  return { app, credentialsFor };
}

test("model API authenticates, protects mutations, isolates credentials, and lists all three catalogs", async () => {
  const { app, credentialsFor } = await appForModels();

  try {
    expect((await app.inject("/api/model-providers")).statusCode).toBe(401);
    const url = "/api/model-providers/openrouter/credentials";
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          headers: { "x-user": "alice" },
          payload: { apiKey: "secret" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "PUT", url, headers, payload: { apiKey: "secret" } })).statusCode,
    ).toBe(204);
    expect(await credentialsFor("alice").read("openrouter")).toEqual({
      type: "api_key",
      key: "secret",
    });
    expect(await credentialsFor("bob").read("openrouter")).toBeUndefined();
    const listed = await app.inject({ url: "/api/model-providers", headers });
    expect(listed.body).toContain('"connected":true');
    expect(listed.body).not.toContain("secret");
    expect(listed.headers["cache-control"]).toBe("no-store");

    for (const provider of modelProviderSchema.options) {
      const result = await app.inject({ url: `/api/model-providers/${provider}/models`, headers });
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('"thinkingLevels":[');
    }

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/threads",
          headers,
          payload: { prompt: "hi", clientMessageId: "first" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "DELETE", url, headers })).statusCode).toBe(204);
    expect(await credentialsFor("alice").read("openrouter")).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("ChatGPT device flow uses Pi's headless login and stores tokens without returning them", async () => {
  const { app, credentialsFor } = await appForModels();
  const exchange = Promise.withResolvers<void>();
  const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        url: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        if (String(url).endsWith("/deviceauth/usercode"))
          return Response.json({
            device_auth_id: "private-device-id",
            user_code: "ABCD-EFGH",
            interval: "1",
          });

        if (String(url).endsWith("/deviceauth/token")) {
          await exchange.promise;

          return Response.json({
            authorization_code: "private-code",
            code_verifier: "private-verifier",
            code_challenge: "challenge",
          });
        }

        expect(String(url)).toBe("https://auth.openai.com/oauth/token");
        expect(String(init?.body)).toContain("private-verifier");

        return Response.json({
          access_token: access,
          refresh_token: "private-refresh",
          expires_in: 3600,
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  try {
    const started = await app.inject({
      method: "POST",
      url: "/api/model-providers/openai-codex/device-login",
      headers,
    });

    expect(started.statusCode).toBe(202);

    const login = z
      .object({
        id: z.uuid(),
        status: z.string(),
        userCode: z.string(),
        verificationUri: z.string(),
      })
      .parse(JSON.parse(started.body));

    expect(login.status).toBe("pending");
    expect(login.userCode).toBe("ABCD-EFGH");
    expect(login.verificationUri).toBe("https://auth.openai.com/codex/device");
    expect(started.body).not.toContain("private-");
    const statusUrl = `/api/model-providers/openai-codex/device-login/${login.id}`;
    expect((await app.inject({ url: statusUrl, headers: { "x-user": "bob" } })).statusCode).toBe(
      404,
    );
    exchange.resolve();

    for (
      let attempt = 0;
      attempt < 100 && !(await credentialsFor("alice").read("openai-codex"));
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await app.inject({ url: statusUrl, headers })).body).toContain('"status":"authorized"');
    expect(await credentialsFor("alice").read("openai-codex")).toMatchObject({
      access,
      refresh: "private-refresh",
      accountId: "account",
    });
    expect((await app.inject({ url: statusUrl, headers })).body).not.toContain("private-");
    await app.inject({
      method: "DELETE",
      url: "/api/model-providers/openai-codex/credentials",
      headers,
    });
    expect(await credentialsFor("alice").read("openai-codex")).toBeUndefined();
  } finally {
    exchange.resolve();
    fetch.mockRestore();
    await app.close();
  }
});

test("deleting a pending device login prevents a late OAuth result from restoring credentials", async () => {
  const { app, credentialsFor } = await appForModels();
  const oauth = modelProviders.find((provider) => provider.id === "openai-codex")?.auth.oauth;

  if (!oauth) throw new Error("Missing ChatGPT provider");
  const completed = Promise.withResolvers<OAuthCredential>();

  const login = spyOn(oauth, "login").mockImplementation(async (interaction) => {
    interaction.notify({
      type: "device_code",
      userCode: "CODE",
      verificationUri: "https://auth.openai.com/codex/device",
    });

    return completed.promise;
  });

  try {
    const started = await app.inject({
      method: "POST",
      url: "/api/model-providers/openai-codex/device-login",
      headers,
    });

    expect(started.body).toContain('"status":"pending"');
    await app.inject({
      method: "DELETE",
      url: "/api/model-providers/openai-codex/credentials",
      headers,
    });
    completed.resolve({
      type: "oauth",
      access: "late-access",
      refresh: "late-refresh",
      expires: Date.now() + 3600000,
      accountId: "account",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await credentialsFor("alice").read("openai-codex")).toBeUndefined();
  } finally {
    login.mockRestore();
    await app.close();
  }
});

test("upstream device login errors never expose response bodies", async () => {
  const { app } = await appForModels();
  const oauth = modelProviders.find((provider) => provider.id === "openai-codex")?.auth.oauth;

  if (!oauth) throw new Error("Missing ChatGPT provider");
  const login = spyOn(oauth, "login").mockRejectedValue(new Error("private-upstream-token"));

  try {
    const failed = await app.inject({
      method: "POST",
      url: "/api/model-providers/openai-codex/device-login",
      headers,
    });

    expect(failed.body).toContain('"status":"failed"');
    expect(failed.body).not.toContain("private-upstream-token");
  } finally {
    login.mockRestore();
    await app.close();
  }
});
