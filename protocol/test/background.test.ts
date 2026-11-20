/**
 * Path: protocol/test/background.test.ts
 * Used by: pnpm test.
 * Purpose: Contract tests for the background command routes' params and query.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BackgroundCommandParams, BackgroundOutputQuery } from '../src/background.ts';

test('the output route takes a command ID and a byte offset', () => {
  assert.equal(BackgroundOutputQuery.parse({}).offset, 0);
  assert.equal(BackgroundOutputQuery.parse({ offset: '4096' }).offset, 4096);

  for (const offset of ['-1', '1.5', 'x']) assert.equal(BackgroundOutputQuery.safeParse({ offset }).success, false);

  const sessionId = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

  assert.equal(BackgroundCommandParams.safeParse({ sessionId, commandId: 'not-a-uuid' }).success, false);
  assert.equal(BackgroundCommandParams.safeParse({ sessionId, commandId: sessionId }).success, true);
});
