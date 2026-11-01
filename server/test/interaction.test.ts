/**
 * Path: server/test/interaction.test.ts
 * Used by: pnpm test.
 * Purpose: ask_user_question ends the run and its answer starts the next one, across a restart and a stopped sandbox; todos follow the conversation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { type AnswerQuestionRequest, Question, type QuestionItems } from '@cloud-swe/protocol/interaction';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { z } from 'zod';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';

const MODEL = 'claude-sonnet-5-5';
const option = (label: string) => ({ label, description: `About ${label}` });

const questions = [
  { question: 'Which cache?', header: 'Cache', options: [option('Redis'), option('LRU')] },
  { question: 'Which checks?', header: 'Checks', options: [option('Lint'), option('Test')], multiSelect: true },
];

type Args = ToolCall['arguments'];

const call = (name: string, args: Args) => ({ id: crypto.randomUUID(), name, arguments: args });
const ask = (items: z.input<typeof QuestionItems> = questions) => call('ask_user_question', { questions: items });
const todo = (args: Args) => call('todo', args);

test(
  'a question ends the run, survives a restart and a stopped sandbox, and its first answer starts one new run',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();
      const path = `/v1/sessions/${session.id}`;
      const answer = (id: string, body: AnswerQuestionRequest) => rig.api(`${path}/questions/${id}`, body);

      await rig.accepted(await rig.send(session.id, 'Add caching', undefined, ask()));
      const asked = await rig.settled(session.id);
      assert.equal(asked.run.kind, 'completed');
      assert.equal(rig.bodies.length, 1, 'the question ends the run without another model request');
      const [question] = asked.questions;
      assert.equal(question?.state, 'pending');
      assert.equal(question.questions[1]?.multiSelect, true);
      assert.deepEqual((await rig.snapshot(session.id)).session.questions, asked.questions);

      assert.equal((await answer(crypto.randomUUID(), { decline: true })).status, 404);
      assert.equal((await answer(question.id, { answers: [{ questionIndex: 0, optionIndexes: [0] }] })).status, 400);
      assert.equal((await rig.session(session.id)).questions[0]?.state, 'pending', 'a partial answer changes nothing');

      await rig.restart();
      assert.equal((await rig.session(session.id)).questions[0]?.state, 'pending');

      await rig.sandbox(session.workspace.id, '/stop', '{}');
      await rig.until(
        () => rig.session(session.id),
        (current) => current.workspace.state === 'stopped',
      );

      const answers = [
        { questionIndex: 0, optionIndexes: [], text: 'Memcached' },
        { questionIndex: 1, optionIndexes: [0, 1] },
      ];

      const answered = await answer(question.id, { answers });
      assert.equal(answered.status, 200, await answered.clone().text());
      assert.equal(Question.parse(await answered.json()).state, 'answered');
      await rig.until(
        async () => rig.bodies.length,
        (count) => count === 2,
      );
      await rig.settled(session.id);
      assert.match(
        rig.bodies.at(-1) ?? '',
        /User has answered your questions: \\"Which cache\?\\"=\\"Memcached\\"\. \\"Which checks\?\\"=\\"Lint, Test\\"\./,
      );
      assert.equal(rig.requests('POST', /\/resume$/).length, 1, 'the answer resumes the stopped sandbox');

      // A lost receipt or a second client gets the first answer back and starts nothing.
      const repeated = await answer(question.id, { decline: true });
      assert.equal(repeated.status, 200);
      assert.equal(Question.parse(await repeated.json()).state, 'answered');
      assert.equal(rig.bodies.length, 2);

      await rig.accepted(await rig.send(session.id, 'Again', undefined, ask()));
      await rig.until(
        () => rig.session(session.id),
        (current) => current.questions.length === 2 && current.run.kind === 'completed',
      );
      const declined = (await rig.session(session.id)).questions.at(-1);
      assert.ok(declined);
      const models = rig.bodies.length;
      assert.equal((await answer(declined.id, { decline: true })).status, 200);
      await rig.until(
        async () => rig.bodies.length,
        (count) => count === models + 1,
      );
      assert.match(rig.bodies.at(-1) ?? '', /User declined to answer questions/);
      await rig.settled(session.id);
    } finally {
      await rig.close();
    }
  },
);

test(
  'a rejected question files nothing, and a question beside other work leaves the run going',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();
      const bad = [{ question: 'Which?', header: 'Which', options: [option('Other'), option('LRU')] }];

      await rig.accepted(await rig.send(session.id, 'Go', undefined, ask(bad)));
      await rig.until(
        async () => rig.bodies.length,
        (count) => count === 2,
      );
      await rig.settled(session.id);
      const rejected = toolResults(rig.bodies.at(-1) ?? '').at(-1);
      assert.equal(rejected?.isError, true);
      assert.match(rejected?.output ?? '', /Do not author "Other"/);
      assert.deepEqual((await rig.session(session.id)).questions, []);

      // Pi ends a run only when every call of the round asks for it, so the model is told to end its turn.
      let round = [ask(), todo({ action: 'create', subject: 'Beside it' })];

      rig.setAnswer(() => {
        const answer = modelAnswer(MODEL, round);
        round = [];

        return answer;
      });

      const before = rig.bodies.length;
      await rig.accepted(await rig.send(session.id, 'Both'));
      await rig.until(
        async () => rig.bodies.length,
        (count) => count === before + 2,
      );
      const done = await rig.settled(session.id);
      assert.equal(done.questions.length, 1);
      assert.equal(done.todos.length, 1);
      assert.match(rig.bodies.at(-1) ?? '', /End your turn now/);
    } finally {
      await rig.close();
    }
  },
);

test('codemode can use todo but not ask_user_question', { timeout: 60_000 }, async () => {
  const rig = await lifecycleRig();

  try {
    const session = await rig.create();

    const code = `
      await tools.todo({ action: 'create', subject: 'From a script' });
      return 'can ask: ' + ALL_TOOLS.some((tool) => tool.name === 'ask_user_question');
    `;

    await rig.accepted(await rig.send(session.id, 'Script', undefined, call('codemode', { code })));
    await rig.until(
      async () => rig.bodies.length,
      (count) => count === 2,
    );
    const done = await rig.settled(session.id);
    assert.deepEqual(
      done.todos.map(({ subject }) => subject),
      ['From a script'],
    );
    assert.match(toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '', /can ask: false/);
  } finally {
    await rig.close();
  }
});

test('todos reach clients live and survive a restart and compaction', { timeout: 120_000 }, async () => {
  const rig = await lifecycleRig();

  try {
    const session = await rig.create();
    const events = await rig.events(session.id);

    const run = async (args: Args) => {
      const before = rig.bodies.length;
      await rig.accepted(await rig.send(session.id, 'Todo', undefined, todo(args)));
      await rig.until(
        async () => rig.bodies.length,
        (count) => count === before + 2,
      );
      await rig.settled(session.id);

      return toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output;
    };

    assert.equal(await run({ action: 'create', subject: 'First' }), 'Created #1: First (pending)');
    assert.equal(await run({ action: 'create', subject: 'Second', blockedBy: [1] }), 'Created #2: Second (pending)');

    for (;;) {
      const frame = await events.next();

      if (frame.session.todos.length === 2) break;
    }

    await events.close();

    assert.equal(
      await run({ action: 'update', id: 1, status: 'in_progress', activeForm: 'working' }),
      'Updated #1 (pending → in_progress)',
    );
    assert.equal(await run({ action: 'delete', id: 2 }), 'Deleted #2: Second');
    assert.match((await run({ action: 'update', id: 99, status: 'completed' })) ?? '', /#99 not found/);

    const expected = [{ id: 1, subject: 'First', activeForm: 'working', status: 'in_progress', blockedBy: [] }];
    assert.deepEqual((await rig.snapshot(session.id)).session.todos, expected, 'tombstones stay off the wire');

    await rig.restart();
    assert.deepEqual((await rig.session(session.id)).todos, expected);

    for (const label of ['A', 'B', 'C']) {
      await rig.accepted(await rig.send(session.id, `${label} ${'lorem '.repeat(10_000)}`));
      await rig.settled(session.id);
    }

    const compact = await rig.api(`/v1/sessions/${session.id}/compact`, {});
    assert.equal(compact.status, 202, await compact.clone().text());

    const compacted = await rig.until(
      () => rig.session(session.id),
      (current) => current.compaction === null && current.compactionFailure === null,
      2000,
    );

    assert.deepEqual(compacted.todos, expected);
    assert.match((await run({ action: 'list' })) ?? '', /\[in_progress\] #1 First \(working\)/);
  } finally {
    await rig.close();
  }
});
