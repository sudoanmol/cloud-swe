import { expect, test } from "bun:test";

import { createPiQuestionTools } from "../src/question-tools";

// SAFETY: The question tool under test does not read the Pi extension context.
const extensionContext = {} as never;

test("ask_questions validates unique IDs and stores one immutable pending request", async () => {
  const questions = createPiQuestionTools();
  const ask = questions.ask;

  const input = {
    questions: [
      {
        id: "deploy_target",
        header: "Deploy",
        question: "Where should this deploy?",
        choices: [
          { label: "Staging", description: "Deploy to the staging environment." },
          { label: "Production", description: "Deploy to the production environment." },
        ],
      },
    ],
  };

  const answer = await ask.execute(
    "tool-call",
    input,
    new AbortController().signal,
    undefined,
    extensionContext,
  );

  const pending = questions.pending();

  expect(answer.terminate).toBe(true);
  expect(pending).toMatchObject({ toolCallId: "tool-call", questions: input.questions });
  expect(pending?.id).toBeString();
  expect(
    await ask.execute(
      "later-call",
      input,
      new AbortController().signal,
      undefined,
      extensionContext,
    ),
  ).toMatchObject({ details: { skipped: true }, terminate: true });
});

test("request_browser_handoff exists only with the hosted browser and waits as one question", async () => {
  expect(createPiQuestionTools().tools.map((tool) => tool.name)).toEqual(["ask_questions"]);
  const questions = createPiQuestionTools({ browser: true });

  expect(questions.tools.map((tool) => tool.name)).toEqual([
    "ask_questions",
    "request_browser_handoff",
  ]);

  const result = await questions.handoff.execute(
    "handoff-call",
    { reason: "  Sign in to Vercel.  " },
    new AbortController().signal,
    undefined,
    extensionContext,
  );

  expect(result).toMatchObject({ details: { status: "awaiting_browser" }, terminate: true });
  expect(questions.pending()).toMatchObject({
    toolCallId: "handoff-call",
    browserHandoff: true,
    questions: [{ id: "browser", header: "Browser", question: "Sign in to Vercel." }],
  });
});

test("ask_questions rejects duplicate IDs and invalid choice counts", async () => {
  const ask = createPiQuestionTools().ask;

  await expect(
    ask.execute(
      "call",
      {
        questions: [
          { id: "same", header: "First", question: "First?" },
          { id: "same", header: "Second", question: "Second?" },
        ],
      },
      new AbortController().signal,
      undefined,
      extensionContext,
    ),
  ).rejects.toThrow("unique");

  await expect(
    createPiQuestionTools().ask.execute(
      "call",
      {
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Pick one",
            choices: [{ label: "Only", description: "Only one choice." }],
          },
        ],
      },
      new AbortController().signal,
      undefined,
      extensionContext,
    ),
  ).rejects.toThrow();
});
