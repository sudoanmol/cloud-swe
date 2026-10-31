/**
 * Path: server/test/errors.test.ts
 * Used by: pnpm test.
 * Purpose: Every API error code has a status and a complete, valid message.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, ApiErrorCode } from '@cloud-swe/protocol';

import { API_ERRORS, renderMessage } from '../src/errors.ts';

test('every API error code has a status and a complete, valid message', () => {
  assert.deepEqual(Object.keys(API_ERRORS).sort(), [...ApiErrorCode.options].sort());

  for (const code of ApiErrorCode.options) {
    const { status } = API_ERRORS[code];
    const message = renderMessage(code, { limit: 4 });

    assert.ok(status >= 400 && status < 600, code);
    assert.ok(message.length > 0, code);
    assert.doesNotMatch(message, /[{}]/, code);
    assert.ok(ApiError.safeParse({ error: { code, message } }).success, code);
  }

  assert.match(renderMessage('sandbox_limit_reached', { limit: 4 }), /limit of 4 running/);
});
