import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelCredentialStatus, SetModelCredentialRequest, StoredModelCredential } from '../src/credentials.ts';

test('keys are write-only, bounded and separate from credential metadata', () => {
  assert.deepEqual(SetModelCredentialRequest.parse({ key: '  private  ' }), { key: 'private' });

  for (const key of ['', '  ', 'x'.repeat(8193)])
    assert.equal(SetModelCredentialRequest.safeParse({ key }).success, false);
  assert.equal(
    ModelCredentialStatus.safeParse({ provider: 'anthropic', configured: true, source: 'client', key: 'private' })
      .success,
    false,
  );
  assert.equal(
    ModelCredentialStatus.safeParse({ provider: 'anthropic', configured: true, source: 'disabled' }).success,
    false,
  );
  assert.ok(StoredModelCredential.safeParse({ kind: 'disabled' }).success);
});
