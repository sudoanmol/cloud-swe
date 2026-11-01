/**
 * Path: server/src/tools/questions.ts
 * Used by: server/src/sessions/thread.ts, server/src/tools/registry.ts.
 * Purpose: ask_user_question: files durable questions and ends the run, then delivers the user's answer as one follow-up message.
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

// Open questions always show; this many answered ones stay visible so clients can render outcomes.
const RECENT_ANSWERED = 20;

const DESCRIPTION = `Ask the user one or more structured questions and wait for their answer. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- The answer arrives as the user's next message, so end your turn after calling this. It may take a long time.
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
 * count every eviction against Pi's restart limit. So the question ends the run, and the answer starts the next one.
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
        await writeQuestion(host.storage, {
          delivered: false,
          question: { id, state: 'pending', questions: items.data, createdAt: new Date().toISOString() },
        });
      }

      return {
        ...text('Your questions were sent to the user. End your turn now: the answer arrives as their next message.'),
        control: { terminate: true },
      };
    },
  });
}

/** Open questions plus the newest answered ones, oldest first. */
export async function questionProjection(storage: Pick<Storage, 'list'>): Promise<Question[]> {
  const rows = await storage.list<unknown>({ prefix: PREFIX });

  const all = [...rows.values()]
    .map((raw) => StoredQuestion.parse(raw).question)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

  const answered = all.filter((question) => question.state !== 'pending').slice(-RECENT_ANSWERED);

  return all.filter((question) => question.state === 'pending' || answered.includes(question)).slice(-100);
}

type AnswerHost = {
  storage: Storage;
  // The normal message path, whose admission is idempotent on the operation ID.
  deliver: (request: SubmitMessageRequest) => Promise<Response>;
  // Tells connected clients the session's questions changed; Pi doesn't publish them.
  changed: () => void;
};

/**
 * The first answer wins and is saved before delivery. A refused delivery returns its error for the client to retry;
 * ponytail: nothing retries by itself, so add a job like ApprovalDelivery if clients ever stop retrying.
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

    stored = { question: next, delivered: false };
    await writeQuestion(host.storage, stored);
    host.changed();
  }

  if (!stored.delivered) {
    const response = await host.deliver(
      SubmitMessageRequest.parse({
        operationId: await deterministicUuid('question-answer:' + id),
        mode: 'followUp',
        text: answerMessage(stored.question),
      }),
    );

    if (response.status !== 202) return response;
    await writeQuestion(host.storage, { ...stored, delivered: true });
  }

  return Response.json(stored.question);
}
