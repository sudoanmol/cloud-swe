/**
 * Path: protocol/src/interaction.ts
 * Used by: the @cloud-swe/protocol/interaction package export, protocol/src/{index,storage}.ts.
 * Purpose: The contracts of ask_user_question and todo: questions, answers and how an answer reads to the model, and the todo list.
 */

import { z } from 'zod';

export const QUESTION_LIMITS = {
  questions: 4,
  question: 1000,
  header: 16,
  options: 4,
  label: 60,
  description: 500,
  preview: 8000,
  answer: 8000,
} as const;

// Clients offer a typed answer on every question themselves, so the model must not author one.
const RESERVED_LABELS = new Set(['other', 'type something.']);

const QuestionItem = z
  .strictObject({
    question: z.string().min(1).max(QUESTION_LIMITS.question),
    header: z.string().min(1).max(QUESTION_LIMITS.header),
    options: z
      .array(
        z.strictObject({
          label: z.string().min(1).max(QUESTION_LIMITS.label),
          description: z.string().min(1).max(QUESTION_LIMITS.description),
          preview: z.string().min(1).max(QUESTION_LIMITS.preview).optional(),
        }),
      )
      .min(2)
      .max(QUESTION_LIMITS.options),
    multiSelect: z.boolean().default(false),
  })
  .superRefine(({ options }, ctx) => {
    const labels = options.map((option) => option.label.toLowerCase());

    if (labels.some((label) => RESERVED_LABELS.has(label)))
      ctx.addIssue({ code: 'custom', message: 'Do not author "Other": the user can always type their own answer' });

    if (new Set(labels).size !== labels.length)
      ctx.addIssue({ code: 'custom', message: 'Two options of a question share a label' });
  });

export const QuestionItems = z
  .array(QuestionItem)
  .min(1)
  .max(QUESTION_LIMITS.questions)
  .refine((items) => new Set(items.map((item) => item.question)).size === items.length, 'Two questions are identical');

export type QuestionItems = z.infer<typeof QuestionItems>;

export const ResolvedAnswer = z.strictObject({
  questionIndex: z.int().nonnegative(),
  // The labels the user chose.
  selected: z.array(z.string()).max(QUESTION_LIMITS.options),
  text: z.string().min(1).max(QUESTION_LIMITS.answer).optional(),
});

export type ResolvedAnswer = z.infer<typeof ResolvedAnswer>;

const questionFields = { id: z.uuid(), questions: QuestionItems, createdAt: z.iso.datetime() };

export const Question = z.discriminatedUnion('state', [
  z.strictObject({ ...questionFields, state: z.literal('pending') }),
  z.strictObject({
    ...questionFields,
    state: z.literal('answered'),
    answers: z.array(ResolvedAnswer).min(1).max(QUESTION_LIMITS.questions),
    decidedAt: z.iso.datetime(),
  }),
  z.strictObject({ ...questionFields, state: z.literal('declined'), decidedAt: z.iso.datetime() }),
]);

export type Question = z.infer<typeof Question>;

const AnswerItem = z.strictObject({
  questionIndex: z.int().nonnegative(),
  optionIndexes: z.array(z.int().nonnegative()).max(QUESTION_LIMITS.options).default([]),
  text: z.string().max(QUESTION_LIMITS.answer).optional(),
});

export const AnswerQuestionRequest = z.union([
  z.strictObject({ answers: z.array(AnswerItem).min(1).max(QUESTION_LIMITS.questions) }),
  z.strictObject({ decline: z.literal(true) }),
]);

export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequest>;

export const QuestionParams = z.strictObject({ sessionId: z.uuid(), questionId: z.uuid() });

/** All or nothing: every question answered once, or undefined. A partial answer would read to the model as complete. */
export function resolveAnswers(
  items: QuestionItems,
  answers: readonly z.infer<typeof AnswerItem>[],
): ResolvedAnswer[] | undefined {
  if (answers.length !== items.length) return undefined;
  const resolved: ResolvedAnswer[] = [];

  for (const [questionIndex, item] of items.entries()) {
    const matching = answers.filter((answer) => answer.questionIndex === questionIndex);
    const [answer] = matching;

    if (!answer || matching.length !== 1) return undefined;
    const { optionIndexes } = answer;
    const text = answer.text?.trim() ? answer.text : undefined;

    if (answer.text !== undefined && text === undefined) return undefined;

    if (new Set(optionIndexes).size !== optionIndexes.length) return undefined;

    if (optionIndexes.length === 0 && text === undefined) return undefined;

    // One choice on a single-select question: an option or the user's own words.
    if (!item.multiSelect && optionIndexes.length + (text === undefined ? 0 : 1) !== 1) return undefined;
    const selected = optionIndexes.map((index) => item.options[index]?.label);

    if (!selected.every((label) => label !== undefined)) return undefined;
    resolved.push(text === undefined ? { questionIndex, selected } : { questionIndex, selected, text });
  }

  return resolved;
}

/** What the model receives, in the words of the Pi package this tool follows. */
export function answerMessage(question: Question): string {
  if (question.state !== 'answered') return 'User declined to answer questions';

  const segments = question.answers.map(({ questionIndex, selected, text }) => {
    const answer = [...selected, ...(text === undefined ? [] : [text])].join(', ');

    return `"${question.questions[questionIndex]?.question}"="${answer}".`;
  });

  return `User has answered your questions: ${segments.join(' ')} You can now continue with the user's answers in mind.`;
}

export const TODO_LIMITS = { tasks: 100, subject: 500, description: 2000, activeForm: 200 } as const;

export const TodoStatus = z.enum(['pending', 'in_progress', 'completed']);

export type TodoStatus = z.infer<typeof TodoStatus>;

export const Todo = z.strictObject({
  id: z.int().positive(),
  subject: z.string().min(1).max(TODO_LIMITS.subject),
  description: z.string().max(TODO_LIMITS.description).optional(),
  // The present-continuous label shown while the task is in progress.
  activeForm: z.string().max(TODO_LIMITS.activeForm).optional(),
  status: TodoStatus,
  blockedBy: z.array(z.int().positive()).max(TODO_LIMITS.tasks),
});

export type Todo = z.infer<typeof Todo>;
