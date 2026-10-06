import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  browserHandoffQuestionId,
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

const handoffParameters = Type.Object({
  reason: Type.String({
    minLength: 1,
    maxLength: 1_000,
    description: "What the user should do, for example 'Sign in to Vercel with your account'",
  }),
});

/** The handoff tool exists only when the hosted browser is configured. */
export function createPiQuestionTools(options: { browser?: boolean } = {}) {
  let pending: QuestionRequestPayload | undefined;

  const waiting = {
    content: [{ type: "text" as const, text: "Not executed: waiting for the pending answers." }],
    details: { skipped: true },
    terminate: true,
  };

  const tool: ToolDefinition<typeof parameters, unknown, unknown> = {
    name: "ask_questions",
    label: "Ask questions",
    promptSnippet: "Ask the user up to three questions and wait for the answers",
    promptGuidelines: [
      "Use ask_questions only for decisions you cannot resolve from the request or the code",
    ],
    description:
      "Ask the user one to three questions and stop until every question has an answer. Free-text answers are allowed.",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, params) => {
      if (pending) return waiting;

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

  /**
   * A handoff is a question whose answer is the user handing the browser back,
   * so it reuses the durable question wait, cancellation, and resume.
   */
  const handoff: ToolDefinition<typeof handoffParameters, unknown, unknown> = {
    name: "request_browser_handoff",
    label: "Hand browser to user",
    promptSnippet:
      "Give the user control of your browser to sign in, pass 2FA or a CAPTCHA, then wait",
    promptGuidelines: [
      "When a page needs the user's credentials, 2FA, or a CAPTCHA, open it in agent-browser first, then call request_browser_handoff instead of asking for secrets in chat",
      "After the handoff ends, take a fresh agent-browser snapshot before continuing; the page has changed",
    ],
    description:
      "Show the user your live browser so they can act in it themselves, and stop until they hand it back. Open the page that needs them first.",
    parameters: handoffParameters,
    executionMode: "sequential",
    execute: async (toolCallId, params) => {
      if (pending) return waiting;

      pending = questionRequestPayloadSchema.parse({
        id: randomUUID(),
        toolCallId,
        browserHandoff: true,
        questions: [
          { id: browserHandoffQuestionId, header: "Browser", question: params.reason.trim() },
        ],
      });

      return {
        content: [
          {
            type: "text",
            text: `Waiting for the user to finish in the browser (request ${pending.id}).`,
          },
        ],
        details: { requestId: pending.id, status: "awaiting_browser" },
        terminate: true,
      };
    },
  };

  return {
    ask: tool,
    handoff,
    tools: options.browser ? [tool, handoff] : [tool],
    pending: () => pending,
  };
}

export type PiQuestionTools = ReturnType<typeof createPiQuestionTools>;
