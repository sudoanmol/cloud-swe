/**
 * Path: protocol/test/interaction.test.ts
 * Used by: pnpm test.
 * Purpose: Contract tests for questions, answers and how an answer reads to the model.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnswerQuestionRequest,
  answerMessage,
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
    [{ ...single, options: [option('Same'), option('same')] }],
    [{ ...single, header: 'A header past the limit' }],
  ])
    assert.equal(QuestionItems.safeParse(bad).success, false, JSON.stringify(bad));
});

test('answers are all or nothing', () => {
  const a = (questionIndex: number, optionIndexes: number[] = [], text?: string) =>
    text === undefined ? { questionIndex, optionIndexes } : { questionIndex, optionIndexes, text };

  assert.deepEqual(resolveAnswers(items, [a(1, [0, 1], 'and types'), a(0, [1])]), [
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
