import { z } from "zod";

const questionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const questionChoiceSchema = z
  .object({
    label: z.string().trim().min(1).max(64),
    description: z.string().trim().min(1).max(256),
  })
  .strict();

export const questionSchema = z
  .object({
    id: questionIdSchema,
    header: z.string().trim().min(1).max(12),
    question: z.string().trim().min(1).max(1_000),
    choices: z.array(questionChoiceSchema).min(2).max(3).optional(),
  })
  .strict();

export const questionsSchema = z
  .array(questionSchema)
  .min(1)
  .max(3)
  .refine((questions) => new Set(questions.map(({ id }) => id)).size === questions.length, {
    message: "Question IDs must be unique",
  });

export const questionRequestPayloadSchema = z
  .object({
    id: z.uuid(),
    toolCallId: z.string().min(1).max(255),
    questions: questionsSchema,
  })
  .strict();

export const questionAnswersSchema = z.record(
  questionIdSchema,
  z.string().trim().min(1).max(10_000),
);

export const questionRequestSchema = questionRequestPayloadSchema.extend({
  runId: z.uuid(),
  threadId: z.uuid(),
  userId: z.string().min(1),
  state: z.enum(["pending", "answered", "cancelled"]),
  answers: questionAnswersSchema.nullable(),
  createdAt: z.coerce.date(),
  answeredAt: z.coerce.date().nullable(),
  cancelledAt: z.coerce.date().nullable(),
});

export type QuestionRequestPayload = z.infer<typeof questionRequestPayloadSchema>;

export type QuestionAnswers = z.infer<typeof questionAnswersSchema>;

export type QuestionRequest = z.infer<typeof questionRequestSchema>;
