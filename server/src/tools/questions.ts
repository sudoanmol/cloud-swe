/**
 * Path: server/src/tools/questions.ts
 * Used by: server/src/sessions/thread.ts, server/src/tools/registry.ts.
 * Purpose: ask_user_question: files durable questions and returns at once, then delivers the user's answer as one steering message.
 */

import { SubmitMessageRequest } from '@cloud-swe/protocol';
import {
  type AnswerQuestionRequest,
  answerMessage,
  type Question,
  QUESTION_LIMITS,
  QuestionItems,
  resolveAnswers,
} from '@cloud-swe/protocol/interaction';
import { StoredQuestion } from '@cloud-swe/protocol/storage';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';

import { apiError } from '../errors.ts';
import { deterministicUuid } from '../git/ids.ts';
import { text } from '../git/tools.ts';
import type { ToolHost } from '../sandbox/host.ts';
import { readParsed } from '../storage.ts';

type Storage = Pick<DurableObjectStorage, 'get' | 'put' | 'list'>;

const PREFIX = 'question:';

// Open questions always show; this many answered ones stay visible so clients can render outcomes. Together they fit
// Session.questions, which holds 100.
const RECENT_ANSWERED = 20;
const MAX_OPEN = 80;

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
        { minItems: 2, maxItems: QUESTION_LIMITS.options },
      ),
      multiSelect: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1, maxItems: QUESTION_LIMITS.questions },
  ),
});

async function readQuestion(storage: Pick<Storage, 'get'>, id: string): Promise<StoredQuestion | undefined> {
  return readParsed(storage, PREFIX + id, StoredQuestion);
}

async function writeQuestion(storage: Pick<Storage, 'put'>, stored: StoredQuestion) {
  await storage.put(PREFIX + stored.question.id, StoredQuestion.parse(stored));
}

/**
 * A person can take days to answer, and a tool task waiting that long would keep the Thread and the sandbox running and
 * count every eviction against Pi's restart limit. So the tool returns at once, like Codex's request_user_input_async:
 * the agent works on until it needs the answer, then ends its turn. The answer joins the running work or starts a new run.
 * Scripts can't call it: a codemode script could never receive the answer.
 */
export function questionTool(host: Pick<ToolHost, 'storage'>) {
  return defineTool({
    name: 'ask_user_question',
    description: DESCRIPTION,
    parameters,
    callers: ['model'],
    // The ID derives from the call ID, so a replay finds the record instead of filing another.
    replay: 'safe',
    async execute(args, api) {
      const items = QuestionItems.safeParse(args.questions);

      if (!items.success) return text(items.error.issues[0]?.message ?? 'Invalid questions', true);
      const id = await deterministicUuid('question:' + api.callId);

      if (!(await readQuestion(host.storage, id))) {
        const open = (await listQuestions(host.storage)).filter(({ question }) => question.state === 'pending');

        if (open.length >= MAX_OPEN) {
          return text(
            `${MAX_OPEN} questions are already waiting for the user. Wait for answers before asking more.`,
            true,
          );
        }

        await writeQuestion(host.storage, {
          delivered: false,
          question: { id, state: 'pending', questions: items.data, createdAt: new Date().toISOString() },
        });
      }

      return text(
        "Your questions were sent to the user, and the answer arrives later as a message. Keep working on anything that doesn't depend on it. Once you can't go further without it, end your turn.",
      );
    },
  });
}

async function listQuestions(storage: Pick<Storage, 'list'>): Promise<StoredQuestion[]> {
  const rows = await storage.list<unknown>({ prefix: PREFIX });

  return [...rows.values()]
    .map((raw) => StoredQuestion.parse(raw))
    .toSorted((a, b) => a.question.createdAt.localeCompare(b.question.createdAt));
}

// Previews can be 8000 characters per option and every SSE frame carries the questions, so only open ones keep them.
const withoutPreviews = (question: Question): Question => ({
  ...question,
  questions: question.questions.map((item) => ({
    ...item,
    options: item.options.map(({ preview: _preview, ...option }) => option),
  })),
});

/** Open questions plus the newest answered ones without their previews, oldest first. */
export async function questionProjection(storage: Pick<Storage, 'list'>): Promise<Question[]> {
  const all = (await listQuestions(storage)).map((stored) => stored.question);
  const answered = all.filter((question) => question.state !== 'pending').slice(-RECENT_ANSWERED);

  return all.flatMap((question) => {
    if (question.state === 'pending') return [question];

    return answered.includes(question) ? [withoutPreviews(question)] : [];
  });
}

export type AnswerHost = {
  storage: Storage;
  // Whether the session admitted the message. Admission is idempotent on the operation ID.
  deliver: (request: SubmitMessageRequest) => Promise<boolean>;
  // Makes sure the durable delivery job will retry an answer this call leaves undelivered.
  armDelivery: () => Promise<void>;
  // Tells connected clients the session's questions changed; Pi doesn't publish them.
  changed: () => void;
};

/** Sends a decided answer once. Returns whether nothing is owed for it any more. */
async function deliverOnce(host: AnswerHost, stored: StoredQuestion): Promise<boolean> {
  if (stored.delivered || stored.question.state === 'pending') return true;

  const admitted = await host
    .deliver(
      SubmitMessageRequest.parse({
        operationId: await deterministicUuid('question-answer:' + stored.question.id),
        // Reaches an agent that is still working at its next tool boundary, and starts a run if it has stopped.
        mode: 'steer',
        text: answerMessage(stored.question),
      }),
    )
    .catch(() => false);

  // A decided question never changes again, so this write cannot overwrite a newer one.
  if (admitted) await writeQuestion(host.storage, { ...stored, delivered: true });

  return admitted;
}

/** Delivers every answer still owed to the agent. Returns whether any remains. */
export async function deliverAnswers(host: AnswerHost): Promise<boolean> {
  let remaining = false;

  for (const stored of await listQuestions(host.storage)) if (!(await deliverOnce(host, stored))) remaining = true;

  return remaining;
}

/**
 * The first answer wins and is saved before delivery. A refused delivery is left to the delivery job, so the answer
 * reaches the agent once the session can admit it, without any client retrying.
 */
export async function answerQuestion(host: AnswerHost, id: string, request: AnswerQuestionRequest): Promise<Response> {
  let stored = await readQuestion(host.storage, id);

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
    stored = { question: next, delivered: false };
    await writeQuestion(host.storage, stored);
    host.changed();
  }

  await deliverOnce(host, stored);

  return Response.json(stored.question);
}
