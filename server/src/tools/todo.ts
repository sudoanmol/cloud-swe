/**
 * Path: server/src/tools/todo.ts
 * Used by: server/src/sessions/thread.ts, server/src/tools/registry.ts.
 * Purpose: The todo tool: a per-conversation task list in a Pi document, with the status machine and dependency rules of the Pi package.
 */

import { Todo, TODO_LIMITS, TodoStatus } from '@cloud-swe/protocol/interaction';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import { type ConversationId, defineDoc, defineTool, type Harness } from '@earendil-works/pi-durable';

// A deleted task stays as a tombstone, so older `blockedBy` references still resolve.
type Task = Omit<Todo, 'status'> & { status: TodoStatus | 'deleted' };

type TodoState = { tasks: Task[]; nextId: number };

// Rewindable and copied as of the fork entry, so the list follows the conversation like the package's branch replay.
const TodoDoc = defineDoc<TodoState>({
  kind: 'cloud-swe.todos',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ tasks: [], nextId: 1 }),
  checkpointWhen: () => false,
});

const ACTIONS = ['create', 'update', 'list', 'get', 'delete', 'clear'] as const;
const STATUSES = [...TodoStatus.options, 'deleted'] as const;

type Action = {
  action: (typeof ACTIONS)[number];
  id?: number;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: Task['status'];
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
};

const ALLOWED: Record<Task['status'], readonly Task['status'][]> = {
  pending: ['in_progress', 'completed', 'deleted'],
  in_progress: ['pending', 'completed', 'deleted'],
  completed: ['deleted'],
  deleted: [],
};

const fail = (message: string) => ({ error: message });

const text = (message: string, isError = false) => ({ output: [{ type: 'text' as const, text: message }], isError });

const row = (task: Task) => {
  const active = task.status === 'in_progress' && task.activeForm ? ` (${task.activeForm})` : '';
  const blocked = task.blockedBy.length > 0 ? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(',')}` : '';

  return `[${task.status}] #${task.id} ${task.subject}${active}${blocked}`;
};

/** Whether `start` reaches `target` by following `blockedBy` edges. */
function reaches(tasks: readonly Task[], start: number, target: number): boolean {
  const seen = new Set<number>();
  const stack = [start];

  while (stack.length > 0) {
    const id = stack.pop();

    if (id === target) return true;

    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    stack.push(...(tasks.find((task) => task.id === id)?.blockedBy ?? []));
  }

  return false;
}

function missingDependency(tasks: readonly Task[], label: string, ids: readonly number[]): string | undefined {
  for (const id of ids) {
    const task = tasks.find((candidate) => candidate.id === id);

    if (!task) return `${label}: #${id} not found`;

    if (task.status === 'deleted') return `${label}: #${id} is deleted`;
  }

  return undefined;
}

function update(state: TodoState, args: Action, task: Task): { state: TodoState; message: string } | { error: string } {
  const { addBlockedBy = [], removeBlockedBy = [] } = args;
  const mutable = [args.subject, args.description, args.activeForm, args.status];

  if (mutable.every((field) => field === undefined) && addBlockedBy.length + removeBlockedBy.length === 0) {
    return fail(
      'update requires at least one mutable field: subject, description, activeForm, status, addBlockedBy, or removeBlockedBy',
    );
  }

  if (args.subject !== undefined && args.subject.trim() === '') return fail('subject must not be blank');

  if (args.status && args.status !== task.status && !ALLOWED[task.status].includes(args.status))
    return fail(`illegal transition ${task.status} → ${args.status}`);

  if (addBlockedBy.includes(task.id)) return fail(`cannot block #${task.id} on itself`);
  const missing = missingDependency(state.tasks, 'addBlockedBy', addBlockedBy);

  if (missing) return fail(missing);

  if (addBlockedBy.some((id) => reaches(state.tasks, id, task.id)))
    return fail('addBlockedBy would create a cycle in the blockedBy graph');

  const blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])].filter((id) => !removeBlockedBy.includes(id));

  const next: Task = { ...task, blockedBy };

  if (args.subject !== undefined) next.subject = args.subject;

  if (args.description !== undefined) next.description = args.description;

  if (args.activeForm !== undefined) next.activeForm = args.activeForm;

  if (args.status !== undefined) next.status = args.status;

  if (JSON.stringify(next) === JSON.stringify(task)) {
    return {
      state,
      message: `No change: #${task.id} already matches the requested values (status: ${task.status})`,
    };
  }

  const change = next.status === task.status ? '' : ` (${task.status} → ${next.status})`;

  return {
    state: { ...state, tasks: state.tasks.map((candidate) => (candidate.id === task.id ? next : candidate)) },
    message: `Updated #${task.id}${change}`,
  };
}

/** Pure: a rejected call leaves the list untouched. */
export function applyTodo(state: TodoState, args: Action): { state: TodoState; message: string } | { error: string } {
  const { tasks } = state;

  if (args.action === 'list') {
    const shown = tasks.filter((task) => (args.status ? task.status === args.status : task.status !== 'deleted'));

    return { state, message: shown.map((task) => row(task)).join('\n') || 'No tasks' };
  }

  if (args.action === 'clear') {
    return { state: { tasks: [], nextId: 1 }, message: `Cleared ${tasks.length} tasks` };
  }

  if (args.action === 'create') {
    if (!args.subject?.trim()) return fail('subject required for create');

    if (tasks.length >= TODO_LIMITS.tasks) return fail(`The list is full (${TODO_LIMITS.tasks}); clear it first`);
    const blockedBy = [...new Set(args.blockedBy ?? [])];
    const missing = missingDependency(tasks, 'blockedBy', blockedBy);

    if (missing) return fail(missing);

    const task: Task = { id: state.nextId, subject: args.subject, status: 'pending', blockedBy };

    if (args.description !== undefined) task.description = args.description;

    if (args.activeForm !== undefined) task.activeForm = args.activeForm;

    return {
      state: { tasks: [...tasks, task], nextId: state.nextId + 1 },
      message: `Created #${task.id}: ${task.subject} (pending)`,
    };
  }

  if (args.id === undefined) return fail(`id required for ${args.action}`);
  const task = tasks.find((candidate) => candidate.id === args.id);

  if (!task) return fail(`#${args.id} not found`);

  if (args.action === 'get') {
    const blocks = tasks.filter((other) => other.blockedBy.includes(task.id)).map((other) => `#${other.id}`);

    return {
      state,
      message: [
        row(task),
        ...(task.description ? [task.description] : []),
        ...(blocks.length > 0 ? [`blocks: ${blocks.join(',')}`] : []),
      ].join('\n'),
    };
  }

  if (args.action === 'update') return update(state, args, task);

  if (task.status === 'deleted') return fail(`#${task.id} is already deleted`);

  return {
    state: {
      ...state,
      tasks: tasks.map((candidate) => (candidate.id === task.id ? { ...task, status: 'deleted' } : candidate)),
    },
    message: `Deleted #${task.id}: ${task.subject}`,
  };
}

export const todoTool = defineTool({
  name: 'todo',
  description: `Keep a task list the user can see. Actions: create, update, list, get, delete, clear.

- Use it for work with 3 or more steps, when the user gives you a list of tasks, or right after new instructions. Skip it for a single trivial task or a purely conversational request.
- Mark a task in_progress before starting it and completed as soon as it is done; never batch completions. Keep exactly one task in_progress.
- Never mark a task completed while tests fail, the work is partial or errors are unresolved. Keep it in_progress and create a new task for the blocker.
- Change a status with update, for example {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}.
- Use blockedBy on create, and addBlockedBy or removeBlockedBy on update; they merge, so do not resend the whole list. Cycles are rejected.
- A subject is short and imperative; description holds detail; activeForm is the present-continuous label shown while in progress.
- list hides deleted tasks; pass status to filter by one status.`,
  parameters: Type.Object({
    action: StringEnum(ACTIONS),
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    subject: Type.Optional(Type.String({ maxLength: TODO_LIMITS.subject })),
    description: Type.Optional(Type.String({ maxLength: TODO_LIMITS.description })),
    activeForm: Type.Optional(Type.String({ maxLength: TODO_LIMITS.activeForm })),
    status: Type.Optional(StringEnum(STATUSES)),
    blockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: TODO_LIMITS.tasks })),
    addBlockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: TODO_LIMITS.tasks })),
    removeBlockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: TODO_LIMITS.tasks })),
  }),
  async execute(args, api, context) {
    return api.commit(async (tx) => {
      const doc = await tx.doc(TodoDoc, api.conversationId);
      // SAFETY: a copy of the document, which only this file writes. A draft does not outlive its transaction.
      const result = applyTodo(JSON.parse(JSON.stringify(doc)) as TodoState, args);

      if ('error' in result) return text(`Error: ${result.error}`, true);
      doc.tasks = result.state.tasks;
      doc.nextId = result.state.nextId;

      return text(result.message);
    }, context);
  },
});

/** The list as clients see it, without tombstones. */
export async function readTodos(harness: Pick<Harness, 'snapshot'>, conversationId: ConversationId): Promise<Todo[]> {
  const state = await harness.snapshot(TodoDoc, conversationId, BG);

  return Todo.array().parse((state?.tasks ?? []).filter((task) => task.status !== 'deleted'));
}
