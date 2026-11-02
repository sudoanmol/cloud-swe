/**
 * Path: server/test/todo.test.ts
 * Used by: pnpm test.
 * Purpose: The todo status machine, dependency rules and result strings.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyTodo } from '../src/tools/todo.ts';

type State = Parameters<typeof applyTodo>[0];

type Args = Parameters<typeof applyTodo>[1];

test('todo follows the package status machine, dependency rules and result strings', () => {
  let state: State = { tasks: [], nextId: 1 };

  const ok = (args: Args, message: string) => {
    const result = applyTodo(state, args);
    assert.ok('state' in result, JSON.stringify(result));
    assert.equal(result.message, message);
    state = result.state;
  };

  const rejected = (args: Args, error: string) => assert.deepEqual(applyTodo(state, args), { error });

  ok({ action: 'list' }, 'No tasks');
  rejected({ action: 'create', subject: '  ' }, 'subject required for create');
  ok({ action: 'create', subject: 'Write the parser' }, 'Created #1: Write the parser (pending)');
  ok({ action: 'create', subject: 'Test it', blockedBy: [1] }, 'Created #2: Test it (pending)');
  rejected({ action: 'create', subject: 'x', blockedBy: [9] }, 'blockedBy: #9 not found');

  ok({ action: 'update', id: 1, status: 'in_progress', activeForm: 'parsing' }, 'Updated #1 (pending → in_progress)');
  ok(
    { action: 'update', id: 1, status: 'in_progress' },
    'No change: #1 already matches the requested values (status: in_progress)',
  );
  ok({ action: 'list' }, '[in_progress] #1 Write the parser (parsing)\n[pending] #2 Test it ⛓ #1');
  ok({ action: 'list', status: 'pending' }, '[pending] #2 Test it ⛓ #1');
  ok({ action: 'get', id: 1 }, '[in_progress] #1 Write the parser (parsing)\nblocks: #2');

  rejected({ action: 'update' }, 'id required for update');
  rejected({ action: 'update', id: 9, status: 'pending' }, '#9 not found');
  assert.match(String(Object.values(applyTodo(state, { action: 'update', id: 1 }))[0]), /at least one mutable field/);
  rejected({ action: 'update', id: 1, addBlockedBy: [1] }, 'cannot block #1 on itself');
  rejected({ action: 'update', id: 1, addBlockedBy: [2] }, 'addBlockedBy would create a cycle in the blockedBy graph');

  ok({ action: 'update', id: 1, status: 'completed' }, 'Updated #1 (in_progress → completed)');
  rejected({ action: 'update', id: 1, status: 'in_progress' }, 'illegal transition completed → in_progress');

  ok({ action: 'create', subject: 'Third' }, 'Created #3: Third (pending)');
  ok({ action: 'delete', id: 3 }, 'Deleted #3: Third');
  rejected({ action: 'delete', id: 3 }, '#3 is already deleted');
  rejected({ action: 'update', id: 2, addBlockedBy: [3] }, 'addBlockedBy: #3 is deleted');
  rejected({ action: 'update', id: 3, status: 'pending' }, 'illegal transition deleted → pending');
  ok({ action: 'list', status: 'deleted' }, '[deleted] #3 Third');
  ok({ action: 'update', id: 2, removeBlockedBy: [1] }, 'Updated #2');

  ok({ action: 'clear' }, 'Cleared 3 tasks');
  ok({ action: 'create', subject: 'Fresh' }, 'Created #1: Fresh (pending)');
});

test('only live tasks count toward the cap, and a full list drops its tombstones to make room', () => {
  let state: State = { tasks: [], nextId: 1 };

  const apply = (args: Args) => {
    const result = applyTodo(state, args);
    assert.ok('state' in result, JSON.stringify(result));
    state = result.state;
  };

  for (let index = 0; index < 100; index++) apply({ action: 'create', subject: `Task ${index + 1}` });
  assert.deepEqual(applyTodo(state, { action: 'create', subject: 'One more' }), {
    error: 'The list is full (100); clear it first',
  });

  apply({ action: 'update', id: 2, addBlockedBy: [1] });
  apply({ action: 'delete', id: 1 });
  apply({ action: 'create', subject: 'One more' });

  assert.equal(state.tasks.length, 100);
  assert.equal(
    state.tasks.some((task) => task.id === 1),
    false,
  );
  assert.deepEqual(state.tasks.find((task) => task.id === 2)?.blockedBy, [], 'no reference to the dropped task');
  assert.equal(state.tasks.at(-1)?.id, 101, 'IDs are never reused');
});
