/**
 * Path: server/test/errors.test.ts
 * Used by: pnpm test.
 * Purpose: Every API error code has a status and a complete, valid message; a fault logs one indexable object.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, ApiErrorCode } from '@cloud-swe/protocol';

import { API_ERRORS, logFault, logNotice, renderMessage } from '../src/errors.ts';

test('every API error code has a status and a complete, valid message', () => {
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

test('a fault logs one object with its class and session, never its message', (t) => {
  const error = t.mock.method(console, 'error', () => {});

  logFault('Sandbox replacement failed', new TypeError('token sk-secret leaked'), 'session-1');

  assert.deepEqual(
    error.mock.calls.map((call) => call.arguments),
    [[{ message: 'Sandbox replacement failed', error: 'TypeError', sessionId: 'session-1' }]],
  );
});

test('a notice logs one object with its details as fields', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  logNotice('Orphan sandbox deleted', { sandboxId: 'sandbox-1' });

  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [[{ message: 'Orphan sandbox deleted', sandboxId: 'sandbox-1' }]],
  );
});
