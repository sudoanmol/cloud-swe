import { expect, test } from "bun:test";

import { createPiQuestionTools } from "../src/question-tools";

// SAFETY: The question tool under test does not read the Pi extension context.
const extensionContext = {} as never;

test("ask_questions validates unique IDs and stores one immutable pending request", async () => {
  const questions = createPiQuestionTools();
  const ask = questions.tools[0]!;

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

test("ask_questions rejects duplicate IDs and invalid choice counts", async () => {
  const ask = createPiQuestionTools().tools[0]!;

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
    createPiQuestionTools().tools[0]!.execute(
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
