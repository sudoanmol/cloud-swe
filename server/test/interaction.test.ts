/**
 * Path: server/test/interaction.test.ts
 * Used by: pnpm test.
 * Purpose: ask_user_question returns at once and its answer reaches the agent, across a restart, a stopped sandbox, a refused delivery and a cancellation; todos follow the conversation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CancelRunResponse } from '@cloud-swe/protocol';
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
  'a question survives a restart and a stopped sandbox, and its first answer starts one new run',
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
      assert.equal(rig.bodies.length, 2, 'the agent gets another request after asking');
      assert.match(rig.bodies.at(-1) ?? '', /Keep working on anything/);
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
        { questionIndex: 1, optionIndexes: [1, 0], notes: 'fast ones' },
      ];

      const answered = await answer(question.id, { answers, globalNote: 'ship today' });
      assert.equal(answered.status, 200, await answered.clone().text());
      assert.equal(Question.parse(await answered.json()).state, 'answered');
      await rig.until(
        async () => rig.bodies.length,
        (count) => count === 3,
      );
      await rig.settled(session.id);
      assert.match(
        rig.bodies.at(-1) ?? '',
        /User has answered your questions: \\"Which cache\?\\"=\\"Memcached\\"\. \\"Which checks\?\\"=\\"Lint, Test\\"\. user notes: fast ones\. global note: ship today\./,
      );
      assert.equal(rig.requests('POST', /\/resume$/).length, 1, 'the answer resumes the stopped sandbox');

      // A lost receipt or a second client gets the first answer back and starts nothing.
      const repeated = await answer(question.id, { decline: true });
      assert.equal(repeated.status, 200);
      assert.equal(Question.parse(await repeated.json()).state, 'answered');
      assert.equal(rig.bodies.length, 3);

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

test('a rejected question files nothing, and an answer joins work still running', { timeout: 60_000 }, async () => {
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
    assert.match(rejected?.output ?? '', /Option label is reserved \(Other, Type something\., Next\)/);
    assert.deepEqual((await rig.session(session.id)).questions, []);

    let round = [ask(), rig.bash('sleep 3; printf finished')];

    rig.setAnswer(() => {
      const answer = modelAnswer(MODEL, round);
      round = [];

      return answer;
    });

    const before = rig.bodies.length;
    await rig.accepted(await rig.send(session.id, 'Both'));

    const open = await rig.until(
      () => rig.session(session.id),
      (current) => current.questions.length === 1,
    );

    const [question] = open.questions;
    assert.ok(question);
    assert.equal(open.run.kind, 'running', 'the command is still going when the answer arrives');

    const answers = [
      { questionIndex: 0, optionIndexes: [1] },
      { questionIndex: 1, optionIndexes: [0] },
    ];

    const answered = await rig.api(`/v1/sessions/${session.id}/questions/${question.id}`, { answers });
    assert.equal(answered.status, 200, await answered.clone().text());

    await rig.until(
      async () => rig.bodies.length,
      (count) => count === before + 2,
      800,
    );
    await rig.settled(session.id);
    assert.equal(rig.bodies.length, before + 2, 'the answer joins the run instead of starting another');
    assert.match(rig.bodies.at(-1) ?? '', /User has answered your questions/);
    assert.match(rig.bodies.at(-1) ?? '', /finished/);
  } finally {
    await rig.close();
  }
});

test(
  'an answer the session refuses is delivered later by the job, with no client retry',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();

      await rig.accepted(await rig.send(session.id, 'Add caching', undefined, ask()));
      const [question] = (await rig.settled(session.id)).questions;
      assert.ok(question);

      await rig.sandbox(session.workspace.id, '/stop', '{}');
      await rig.until(
        () => rig.session(session.id),
        (current) => current.workspace.state === 'stopped',
      );

      // The sandbox will not resume, so the session refuses the answer's message.
      rig.setIntercept(({ path }) =>
        path.endsWith('/resume') ? new Response('sandbox unreachable', { status: 503 }) : undefined,
      );
      const before = rig.bodies.length;

      const answered = await rig.api(`/v1/sessions/${session.id}/questions/${question.id}`, { decline: true });
      assert.equal(answered.status, 200, await answered.clone().text());
      assert.equal(Question.parse(await answered.json()).state, 'declined', 'the answer stands');
      assert.equal(rig.bodies.length, before);

      rig.setIntercept(() => undefined);
      await rig.until(
        async () => rig.bodies.length,
        (count) => count > before,
        1600,
      );
      await rig.settled(session.id);
      assert.equal(rig.bodies.length, before + 1, 'delivered once');
      assert.match(rig.bodies.at(-1) ?? '', /User declined to answer questions/);
    } finally {
      await rig.close();
    }
  },
);

test(
  'cancelling keeps a queued answer for the model instead of restoring it to the editor',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();

      await rig.accepted(await rig.send(session.id, 'Add caching', undefined, ask()));
      const [question] = (await rig.settled(session.id)).questions;
      assert.ok(question);

      const work = await rig.accepted(await rig.send(session.id, 'Work', undefined, rig.bash('sleep 30')));
      await rig.until(async () => rig.requests('POST', /\/commands$/)[0], Boolean);

      const answered = await rig.api(`/v1/sessions/${session.id}/questions/${question.id}`, { decline: true });
      assert.equal(answered.status, 200, await answered.clone().text());

      const queued = await rig.until(
        () => rig.session(session.id),
        (current) => current.pending.some(({ status }) => status === 'queued'),
      );

      assert.equal(queued.pending.length, 2, 'the answer waits behind the running command');

      const cancelled = await rig.api(`/v1/sessions/${session.id}/cancel`, {
        operationId: crypto.randomUUID(),
        runId: work.runId,
      });

      assert.equal(cancelled.status, 202, await cancelled.clone().text());
      assert.deepEqual(CancelRunResponse.parse(await cancelled.json()).restoredMessages, []);

      const stopped = await rig.settled(session.id);
      assert.equal(stopped.run.kind, 'cancelled');
      assert.equal(stopped.questions[0]?.state, 'declined');

      const before = rig.bodies.length;
      await rig.accepted(await rig.send(session.id, 'Carry on'));
      await rig.settled(session.id);
      assert.equal(rig.bodies.length, before + 1, 'the cancelled answer started no run of its own');
      assert.match(rig.bodies.at(-1) ?? '', /User declined to answer questions[\s\S]*Carry on/);
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
