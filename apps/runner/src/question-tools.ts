import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  questionRequestPayloadSchema,
  type QuestionRequestPayload,
} from "@cloud-swe/db/question-contracts";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";

const parameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64 }),
      header: Type.String({ minLength: 1, maxLength: 12 }),
      question: Type.String({ minLength: 1, maxLength: 1_000 }),
      choices: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ minLength: 1, maxLength: 64 }),
            description: Type.String({ minLength: 1, maxLength: 256 }),
          }),
          { minItems: 2, maxItems: 3 },
        ),
      ),
    }),
    { minItems: 1, maxItems: 3 },
  ),
});

export function createPiQuestionTools() {
  let pending: QuestionRequestPayload | undefined;

  const tool: ToolDefinition<typeof parameters, unknown, unknown> = {
    name: "ask_questions",
    label: "Ask questions",
    description:
      "Ask the user one to three questions and stop until every question has an answer. Free-text answers are allowed.",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, params) => {
      if (pending)
        return {
          content: [{ type: "text", text: "Not executed: waiting for the pending answers." }],
          details: { skipped: true },
          terminate: true,
        };

      pending = questionRequestPayloadSchema.parse({
        id: randomUUID(),
        toolCallId,
        questions: params.questions,
      });

      return {
        content: [
          {
            type: "text",
            text: `Waiting for answers to question request ${pending.id}.`,
          },
        ],
        details: { requestId: pending.id, status: "awaiting_answers" },
        terminate: true,
      };
    },
  };

  return { tools: [tool], pending: () => pending };
}

export type PiQuestionTools = ReturnType<typeof createPiQuestionTools>;
