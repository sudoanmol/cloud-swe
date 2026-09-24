import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { createDb, createThreadStore, publishQuestionRequest } from "@cloud-swe/db";
import { apiFetch, createUser, markOnboarded, signIn } from "./helpers";

// A durable question fixture, not a simulated agent execution. All browser
// reads/answers use the real authenticated API and PostgreSQL event stream.
test("custom question answers lock while pending and survive reload and conflict", async ({
  page,
}) => {
  const user = await createUser(page);
  await signIn(page, user);

  const credential = await apiFetch(page, "/api/model-providers/vercel-ai-gateway/credentials", {
    csrf: true,
    method: "PUT",
    json: { apiKey: "fixture-provider-key" },
  });

  expect(credential.status).toBe(204);
  await markOnboarded(user.id);

  const pool = new Pool({
    connectionString:
      process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:password@127.0.0.1:5432/cloud_swe_web_e2e",
  });

  const requestId = crypto.randomUUID();
  let threadId: string;

  try {
    const db = createDb(pool);
    const store = createThreadStore(db);

    const submitted = await store.submitThread({
      userId: user.id,
      prompt: "Question fixture",
      clientMessageId: crypto.randomUUID(),
    });

    threadId = submitted.threadId;
    const run = await store.loadRun(submitted.runId);

    if (!run) throw new Error("Question fixture run was not created");
    await db.transaction((tx) =>
      publishQuestionRequest(tx, run, {
        id: requestId,
        toolCallId: "question-fixture",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "How much should change?",
            choices: [
              { label: "Small", description: "One file" },
              { label: "Large", description: "All files" },
            ],
          },
        ],
      }),
    );
  } finally {
    await pool.end();
  }

  await page.goto(`/chat/${threadId}`);
  const answer = page.getByRole("textbox", { name: "How much should change? Write your answer" });
  await answer.fill("Only the parser and its tests");
  const sending = Promise.withResolvers<void>();
  await page.route("**/questions/*/answer", async (route) => {
    await sending.promise;
    await route.continue();
  });

  try {
    const submit = page.getByRole("button", { name: "Send answers" });
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(answer).toBeDisabled();
  } finally {
    sending.resolve();
  }

  const summary = page.getByRole("region", { name: "Question answers" });
  await expect(summary).toContainText("Only the parser and its tests");
  await page.reload();
  await expect(summary).toContainText("Only the parser and its tests");
  await expect(page.getByRole("button", { name: "Send answers" })).toHaveCount(0);

  const conflict = await apiFetch(page, `/api/threads/${threadId}/questions/${requestId}/answer`, {
    csrf: true,
    method: "POST",
    json: { answers: { scope: "Change everything" } },
  });

  expect(conflict.status).toBe(409);
  await page.reload();
  await expect(summary).toContainText("Only the parser and its tests");
});
