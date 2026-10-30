import assert from 'node:assert/strict';
import test from 'node:test';

import { BoatApiError, BoatSandboxCreated, BoatSandboxList } from '../src/workspaces/boat-schemas.ts';
import { DockerWorkspaceInfo } from '../src/workspaces/docker-schemas.ts';

const id = 'fa879d6e-bd71-48df-a621-f070c8df45da';

test('sandbox identities are validated per backend', () => {
  assert.ok(
    BoatSandboxCreated.safeParse({ ok: true, type: 'sandbox.created', sandbox: { id: 'bx_23456789' } }).success,
  );
  assert.equal(
    BoatSandboxCreated.safeParse({ ok: true, type: 'sandbox.created', sandbox: { id: 'other' } }).success,
    false,
  );
  assert.ok(
    DockerWorkspaceInfo.safeParse({ provider: 'docker', id, state: 'running', root: `/workspace/${id}` }).success,
  );
  assert.equal(
    DockerWorkspaceInfo.safeParse({ provider: 'docker', id, state: 'running', root: '/workspace' }).success,
    false,
  );
});

test('sandbox recovery validates identities and requires pagination metadata', () => {
  const response = {
    ok: true,
    type: 'sandbox.list',
    sandboxes: [{ id: 'bx_23456789', name: 'cloud-swe-' + id }],
    pageInfo: { hasMore: false },
  };

  assert.ok(BoatSandboxList.safeParse(response).success);
  assert.equal(BoatSandboxList.safeParse({ ...response, pageInfo: undefined }).success, false);
  assert.equal(BoatSandboxList.safeParse({ ...response, sandboxes: [{ id: 'bad', name: 'test' }] }).success, false);
});

test('Boat error envelopes require a code', () => {
  assert.equal(
    BoatApiError.parse({ ok: false, error: { code: 'idempotency_in_progress', message: 'Creating' } }).error.code,
    'idempotency_in_progress',
  );

  for (const raw of [
    {},
    { ok: false, error: { code: 409 } },
    { ok: true, error: { code: 'idempotency_in_progress' } },
  ]) {
    assert.equal(BoatApiError.safeParse(raw).success, false);
  }
});
