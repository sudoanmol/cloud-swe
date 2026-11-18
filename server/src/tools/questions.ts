/**
 * Path: server/src/tools/questions.ts
 * Used by: server/src/sessions/{cut-requests,projection,thread}.ts, server/src/tools/registry.ts.
 * Purpose: ask_user_question: files durable questions and returns at once, then delivers the user's answer as one steering message.
 */

import { FOLLOW_UP_LIMIT } from '@cloud-swe/protocol';
import {
  type AnswerQuestionRequest,
  answerMessage,
  type Question,
  QUESTION_LIMITS,
  QuestionItems,
  resolveAnswers,
} from '@cloud-swe/protocol/interaction';
import { questionView, StoredQuestion } from '@cloud-swe/protocol/storage';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';

import { apiError } from '../errors.ts';
import { type FollowUpHost, followUps, newestEntry, RECENT } from '../follow-ups.ts';
import { deterministicUuid } from '../ids.ts';
import type { ToolHost } from '../sandbox/host.ts';
import type { KvLister } from '../storage.ts';
import { text } from '../tool-result.ts';

// Open questions plus the answered ones that stay visible must fit Session.questions.
const MAX_OPEN = FOLLOW_UP_LIMIT - RECENT;

const questions = followUps({
  prefix: 'question:',
  schema: StoredQuestion,
  item: (stored) => stored.question,
  isOpen: (question) => question.state === 'pending',
  outcome: (question) =>
    question.state === 'pending'
      ? undefined
      : // Reaches an agent that is still working at its next tool boundary, and starts a run if it has stopped.
        { key: 'question-answer:' + question.id, mode: 'steer', text: answerMessage(question) },
});

const DESCRIPTION = `Ask the user one or more structured questions. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- This returns at once, and the answer arrives later as a user message; it may take a long time. Keep working on anything that doesn't depend on the answer, and don't guess at what does. Once you can't go further without it, end your turn.
- Group your clarifying questions into one call, rather than asking several times in a row.
- The user can always type their own answer or decline, so do not author "Other", "Type something." or "Next" as an option.
- Use multiSelect: true when several answers are valid.
- Add a markdown preview to an option of a single-select question to compare real artifacts: a mockup, code or config.
- If you recommend an option, make it the first and add "(Recommended)" at the end of its label.`;

const parameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({
        description: 'The complete question, ending with a question mark',
        maxLength: QUESTION_LIMITS.question,
      }),
      header: Type.String({ description: 'A very short label for the question', maxLength: QUESTION_LIMITS.header }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: '1-5 words', maxLength: QUESTION_LIMITS.label }),
          description: Type.String({
            description: 'What this choice means or costs',
            maxLength: QUESTION_LIMITS.description,
          }),
          preview: Type.Optional(
            Type.String({ description: 'Markdown shown beside the option', maxLength: QUESTION_LIMITS.preview }),
          ),
        }),
        { minItems: QUESTION_LIMITS.minOptions, maxItems: QUESTION_LIMITS.options },
      ),
      multiSelect: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1, maxItems: QUESTION_LIMITS.questions },
  ),
});

/** Scripts can't call it: a codemode script could never receive the answer. */
export function questionTool(host: Pick<ToolHost, 'storage'>) {
  return defineTool({
    name: 'ask_user_question',
    description: DESCRIPTION,
    parameters,
    callers: ['model'],
    // The ID derives from the call ID, so a replay finds the record instead of filing another.
    replay: 'safe',
    async execute(args, api, context) {
      const items = QuestionItems.safeParse(args.questions);

      if (!items.success) return text(items.error.issues[0]?.message ?? 'Invalid questions', true);
      const id = await deterministicUuid('question:' + api.callId);

      if (!(await questions.read(host.storage, id))) {
        if ((await questions.openCount(host.storage)) >= MAX_OPEN) {
          return text(
            `${MAX_OPEN} questions are already waiting for the user. Wait for answers before asking more.`,
            true,
          );
        }

        await questions.write(host.storage, {
          delivered: false,
          afterEntry: await newestEntry(api, context),
          question: { id, state: 'pending', questions: items.data, createdAt: new Date().toISOString() },
        });
      }

      return text(
        "Your questions were sent to the user, and the answer arrives later as a message. Keep working on anything that doesn't depend on it. Once you can't go further without it, end your turn.",
      );
    },
  });
}

// Previews can be 8000 characters per option and every SSE frame carries the questions, so only open ones keep them.
const withoutPreviews = (question: Question): Question => ({
  ...question,
  questions: question.questions.map((item) => ({
    ...item,
    options: item.options.map(({ preview: _preview, ...option }) => option),
  })),
});

/** Open questions plus the newest answered ones, oldest first. */
export async function questionProjection(storage: KvLister): Promise<Question[]> {
  return (await questions.visible(storage))
    .map(questionView)
    .map((question) => (question.state === 'pending' ? question : withoutPreviews(question)));
}

export const deliverAnswers = (host: FollowUpHost) => questions.deliverAll(host);

export const dropCutQuestions = questions.dropCut;

/**
 * The first answer wins and is saved before delivery. A refused delivery is left to the delivery job, so the answer
 * reaches the agent once the session can admit it, without any client retrying.
 */
export async function answerQuestion(
  host: FollowUpHost,
  id: string,
  request: AnswerQuestionRequest,
): Promise<Response> {
  let stored = await questions.read(host.storage, id);

  if (!stored) return apiError('question_not_found');

  if (stored.question.state === 'pending') {
    const { question } = stored;
    const decidedAt = new Date().toISOString();
    let next: Question = { ...question, state: 'declined', decidedAt };

    if ('answers' in request) {
      const answers = resolveAnswers(question.questions, request.answers);

      if (!answers) return apiError('invalid_request');
      next = { ...question, state: 'answered', answers, decidedAt };
      const globalNote = request.globalNote?.trim();

      if (globalNote) next.globalNote = globalNote;
    }

    // Armed before the answer is saved, so a crash right after still leaves a job to deliver it.
    await host.armDelivery();
    stored = await questions.write(host.storage, { ...stored, question: next, delivered: false });
    host.changed();
  }

  await questions.deliver(host, stored);

  return Response.json(questionView(stored.question));
}
