import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { buildServer } from "../src/app";

async function unused(): Promise<never> {
  throw new Error("unused store operation");
}

test("automatic OAuth callback request logs omit code and state", async () => {
  const stream = new PassThrough();
  let logs = "";
  stream.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });

  const app = buildServer({
    logger: { stream },
    auth: { getSession: async () => null, handler: async () => Response.json({ ok: true }) },
    store: {
      listThreads: unused,
      submitThread: unused,
      submitMessage: unused,
      getThread: unused,
      authorizeThread: unused,
      listEvents: unused,
      requestCancel: unused,
      listQuestionRequests: unused,
      answerQuestionRequest: unused,
    },
    trustedOrigins: ["http://127.0.0.1:3001"],
  });

  try {
    await app.inject({
      method: "GET",
      url: "/api/auth/callback/github?code=SYNTHETIC_CODE&state=SYNTHETIC_STATE",
    });
    expect(logs).toContain("/api/auth/callback/github");
    expect(logs).not.toContain("SYNTHETIC_CODE");
    expect(logs).not.toContain("SYNTHETIC_STATE");
  } finally {
    await app.close();
  }
});
