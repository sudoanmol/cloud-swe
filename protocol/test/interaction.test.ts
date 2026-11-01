/**
 * Path: protocol/test/interaction.test.ts
 * Used by: pnpm test.
 * Purpose: Contract tests for questions, answers and how an answer reads to the model.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { z } from 'zod';

import {
  AnswerQuestionRequest,
  answerMessage,
  QUESTION_LIMITS,
  QuestionItems,
  resolveAnswers,
  type Question,
} from '../src/interaction.ts';

const option = (label: string) => ({ label, description: `About ${label}` });

const single = { question: 'Which cache?', header: 'Cache', options: [option('Redis'), option('LRU')] };

const multi = {
  question: 'Which checks?',
  header: 'Checks',
  options: [option('Lint'), option('Test')],
  multiSelect: true,
};

const items = QuestionItems.parse([single, multi]);

test('questions follow the Pi package limits and reserved labels', () => {
  assert.equal(items[0]?.multiSelect, false);

  for (const bad of [
    [],
    Array.from({ length: 5 }, (_, index) => ({ ...single, question: `Q${index}?` })),
    [single, single],
    [{ ...single, options: [option('Only')] }],
    [{ ...single, options: [...single.options, option('3'), option('4'), option('5')] }],
    [{ ...single, options: [option('Other'), option('LRU')] }],
    [{ ...single, options: [option('Same'), option('Same')] }],
    [{ ...single, header: 'A header past the limit' }],
  ])
    assert.equal(QuestionItems.safeParse(bad).success, false, JSON.stringify(bad));
});

test('answers are all or nothing', () => {
  const a = (questionIndex: number, optionIndexes: number[] = [], text?: string) =>
    text === undefined ? { questionIndex, optionIndexes } : { questionIndex, optionIndexes, text };

  assert.deepEqual(resolveAnswers(items, [a(1, [1, 0], 'and types'), a(0, [1])]), [
    { questionIndex: 0, selected: ['LRU'] },
    { questionIndex: 1, selected: ['Lint', 'Test'], text: 'and types' },
  ]);

  for (const bad of [
    [a(0, [0])],
    [a(0, [0]), a(0, [1])],
    [a(0, [0]), a(2, [0])],
    [a(0, [9]), a(1, [0])],
    [a(0, [0, 1]), a(1, [0])],
    [a(0, [0], 'and text'), a(1, [0])],
    [a(0), a(1, [0])],
    [a(0, [0]), a(1, [1, 1])],
    [a(0, [], '   '), a(1, [0])],
  ])
    assert.equal(resolveAnswers(items, bad), undefined, JSON.stringify(bad));

  assert.equal(AnswerQuestionRequest.safeParse({ answers: [], decline: true }).success, false);
  assert.equal(AnswerQuestionRequest.safeParse({ decline: false }).success, false);
  assert.ok(AnswerQuestionRequest.safeParse({ decline: true }).success);
});

test('an answer reads to the model in the words of the Pi package', () => {
  const fields = { id: crypto.randomUUID(), questions: items, createdAt: new Date().toISOString() };
  const decidedAt = new Date().toISOString();

  const answered: Question = {
    ...fields,
    state: 'answered',
    decidedAt,
    answers: [
      { questionIndex: 0, selected: [], text: 'Memcached' },
      { questionIndex: 1, selected: ['Lint', 'Test'] },
    ],
  };

  assert.equal(
    answerMessage(answered),
    `User has answered your questions: "Which cache?"="Memcached". "Which checks?"="Lint, Test". You can now continue with the user's answers in mind.`,
  );

  assert.equal(answerMessage({ ...fields, state: 'declined', decidedAt }), 'User declined to answer questions');
});

test('validation reports the Pi package messages, and labels are case-sensitive', () => {
  const issue = (value: z.input<typeof QuestionItems>) => QuestionItems.safeParse(value).error?.issues[0]?.message;

  assert.equal(issue([single, single]), 'Error: Question text must be unique within an invocation');
  assert.equal(
    issue([{ ...single, options: [option('Next'), option('Next')] }]),
    'Error: Option label is reserved (Other, Type something., Next)',
  );
  assert.equal(
    issue([{ ...single, options: [option('Same'), option('Same')] }]),
    'Error: Option labels must be unique within a question',
  );
  assert.equal(issue([{ ...single, options: [option('Only')] }]), 'Error: Each question requires at least 2 options');
  assert.equal(issue([]), 'Error: At least one question is required');
  assert.ok(QuestionItems.safeParse([{ ...single, options: [option('Same'), option('same')] }]).success);
  assert.ok(QuestionItems.safeParse([{ ...single, options: [option('other'), option('next')] }]).success);
});

test('notes reach the model after their answer, and the longest answer fits in one message', () => {
  const [first] =
    resolveAnswers(items, [
      { questionIndex: 0, optionIndexes: [0], notes: '  keep it small  ' },
      { questionIndex: 1, optionIndexes: [0], notes: '   ' },
    ]) ?? [];

  assert.deepEqual(first, { questionIndex: 0, selected: ['Redis'], notes: 'keep it small' });

  const fields = { id: crypto.randomUUID(), questions: items, createdAt: new Date().toISOString() };

  assert.equal(
    answerMessage({
      ...fields,
      state: 'answered',
      decidedAt: fields.createdAt,
      globalNote: 'ship today',
      answers: [
        { questionIndex: 0, selected: ['Redis'], notes: 'keep it small' },
        { questionIndex: 1, selected: ['Lint'] },
      ],
    }),
    `User has answered your questions: "Which cache?"="Redis". user notes: keep it small. "Which checks?"="Lint". global note: ship today. You can now continue with the user's answers in mind.`,
  );

  const longest = (questionIndex: number) => ({
    question: `${questionIndex}${'q'.repeat(QUESTION_LIMITS.question - 1)}`,
    header: 'Long',
    multiSelect: true,
    options: Array.from({ length: QUESTION_LIMITS.options }, (_, index) => ({
      label: `${index}${'l'.repeat(QUESTION_LIMITS.label - 1)}`,
      description: 'd',
    })),
  });

  const questions = QuestionItems.parse([0, 1, 2, 3].map((index) => longest(index)));

  const message = answerMessage({
    ...fields,
    questions,
    state: 'answered',
    decidedAt: fields.createdAt,
    globalNote: 'g'.repeat(QUESTION_LIMITS.note),
    answers: questions.map((question, questionIndex) => ({
      questionIndex,
      selected: question.options.map(({ label }) => label),
      text: 't'.repeat(QUESTION_LIMITS.answer),
      notes: 'n'.repeat(QUESTION_LIMITS.note),
    })),
  });

  assert.ok(message.length <= 64_000, String(message.length));
});
