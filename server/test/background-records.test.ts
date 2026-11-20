/**
 * Path: server/test/background-records.test.ts
 * Used by: pnpm test.
 * Purpose: A background command's public view for every stored state, the command preview cut, and the byte slicing behind output reads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CommandRecord } from '@cloud-swe/protocol';
import { BACKGROUND_LIMITS } from '@cloud-swe/protocol/background';
import { StoredBackgroundCommand } from '@cloud-swe/protocol/storage';
import type { z } from 'zod';

import { backgroundCommandView, outputSlice } from '../src/sandbox/background.ts';

const id = '9e0f1a2b-3c4d-4e5f-8a7b-8c9d0e1f2a3b';
const identity = { workspaceId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', operationId: id };
const output = { output: 'ready', outputBytes: 5 };
const open = { identity, cancelRequested: false, heartbeat: 3, lastSeenAt: 1, ...output };
const endedAt = '2026-11-20T10:02:00.000Z';

const view = (record: z.input<typeof CommandRecord>, extra: Partial<z.input<typeof StoredBackgroundCommand>> = {}) =>
  backgroundCommandView(
    StoredBackgroundCommand.parse({
      id,
      command: 'pnpm dev',
      cwd: '/home/user/app',
      conversationId: '1',
      startedAt: '2026-11-20T10:00:00.000Z',
      record,
      stoppedBy: null,
      checkedAt: '2026-11-20T10:01:00.000Z',
      endedAt: null,
      ...extra,
    }),
  );

test('every stored state has its public state', () => {
  assert.equal(view({ ...open, kind: 'prepared' }).state, 'starting');

  const stopping = [false, true].map((cancelRequested) => view({ ...open, kind: 'running', cancelRequested }));

  assert.deepEqual(
    stopping.map((command) => command.state === 'running' && command.stopping),
    [false, true],
  );

  const stopped = view(
    { ...output, kind: 'exited', identity, exitCode: 143, termination: 'cancelled' },
    { stoppedBy: 'user', endedAt },
  );

  assert.deepEqual(stopped.state === 'exited' && [stopped.termination, stopped.stoppedBy, stopped.endedAt], [
    'stopped',
    'user',
    endedAt,
  ]);

  // Who asked for a stop means nothing for a command that exited by itself first.
  const exited = view(
    { ...output, kind: 'exited', identity, exitCode: 0, termination: 'exit' },
    { stoppedBy: 'agent', endedAt },
  );

  assert.deepEqual(exited.state === 'exited' && [exited.termination, exited.stoppedBy], ['exit', null]);

  for (const record of [
    { ...output, kind: 'lost', identity, reason: 'gone' },
    { kind: 'not_started', identity, reason: 'gone' },
  ] as const) {
    const lost = view(record, { endedAt });

    assert.deepEqual(lost.state === 'lost' && [lost.reason, lost.endedAt], ['gone', endedAt]);
  }
});

test('a long command is cut to the preview limit without splitting a character', () => {
  const limit = BACKGROUND_LIMITS.commandPreview;
  const long = 'a'.repeat(limit - 2) + '😀' + 'b'.repeat(50);
  const { command } = view({ ...open, kind: 'running' }, { command: long });

  assert.ok(command.length <= limit);
  assert.equal(command, 'a'.repeat(limit - 2) + '…');
  assert.equal(view({ ...open, kind: 'running' }).command, 'pnpm dev');
});

test('output slices by byte offset within the window, on character boundaries', () => {
  // 10 bytes of output so far, of which the window holds the last 6: "défg" is d, é (2 bytes), f, g.
  const window = 'xdéfg';

  assert.deepEqual(outputSlice(window, 10, 0), {
    offset: 4,
    end: 10,
    outputBytes: 10,
    skippedBytes: 4,
    text: 'xdéfg',
  });

  assert.equal(outputSlice(window, 10, 6).text, 'éfg');
  // An offset inside é starts after it.
  assert.deepEqual([outputSlice(window, 10, 7).offset, outputSlice(window, 10, 7).text], [8, 'fg']);
  assert.deepEqual([outputSlice(window, 10, 10).text, outputSlice(window, 10, 99).offset], ['', 10]);

  // A limit stops before a split character, and the end says where to read next.
  assert.deepEqual([outputSlice(window, 10, 5, 2).text, outputSlice(window, 10, 5, 2).end], ['d', 6]);
});
