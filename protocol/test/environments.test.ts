/**
 * Path: protocol/test/environments.test.ts
 * Used by: pnpm test.
 * Purpose: Contract tests for environment, secret, host and header names, values, stored shapes and client views.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EnvironmentName,
  EnvironmentView,
  EXCLUDED_HOSTS,
  HeaderName,
  Hostname,
  NetworkSecretValue,
  SecretName,
  SetNetworkSecretRequest,
  SetVariableRequest,
  StoredEnvironment,
  TRUST_VARS,
  VariableValue,
} from '../src/environments.ts';
import { CreateSessionRequest } from '../src/index.ts';

const ok = (schema: { safeParse: (value: string) => { success: boolean } }, value: string) =>
  schema.safeParse(value).success;

test('environment names are short lowercase slugs', () => {
  for (const name of ['dev', 'prod-2', '0', 'a'.repeat(40)]) assert.ok(ok(EnvironmentName, name), name);

  for (const name of ['', '-dev', 'Dev', 'dev_1', 'a'.repeat(41), 'has space', '../x']) {
    assert.equal(ok(EnvironmentName, name), false, name);
  }
});

test('secret names are env var names, minus platform and shell names', () => {
  for (const name of ['DATABASE_URL', '_x', 'a1', 'A'.repeat(128)]) assert.ok(ok(SecretName, name), name);

  for (const name of [
    '',
    '1X',
    'A-B',
    'A'.repeat(129),
    'CLOUD_SWE_TOKEN',
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'PWD',
    ...TRUST_VARS,
  ]) {
    assert.equal(ok(SecretName, name), false, name);
  }
});

test('hosts are lowercase DNS names, never IPs, ports, wildcards, localhost or excluded hosts', () => {
  for (const host of ['api.openai.com', 'api.anthropic.com', 'a.b', 'x-1.example.co.uk']) {
    assert.ok(ok(Hostname, host), host);
  }

  for (const host of [
    '',
    'localhost',
    'app.localhost',
    'example',
    'API.openai.com',
    '127.0.0.1',
    '[::1]',
    '::1',
    'api.openai.com:443',
    '*.openai.com',
    'api..com',
    '-a.com',
    'a-.com',
    'api.openai.com.',
    'https://api.openai.com',
    `${'a'.repeat(64)}.com`,
    ...EXCLUDED_HOSTS,
  ]) {
    assert.equal(ok(Hostname, host), false, host);
  }

  assert.ok(EXCLUDED_HOSTS.has('github.com') && EXCLUDED_HOSTS.has('registry.npmjs.org'));
});

test('header names are RFC 7230 tokens defaulting to Authorization', () => {
  assert.equal(HeaderName.parse(undefined), 'Authorization');
  assert.ok(ok(HeaderName, 'x-api-key'));

  for (const header of ['', 'a b', 'x:y', 'a'.repeat(65), 'x\r\ny'])
    assert.equal(ok(HeaderName, header), false, header);
});

test('values reject NUL, and network values reject CR and LF', () => {
  assert.ok(ok(VariableValue, ''));
  assert.ok(ok(VariableValue, 'multi\nline'));
  assert.ok(ok(VariableValue, 'é'.repeat(2048)));
  assert.equal(ok(VariableValue, 'é'.repeat(2049)), false);
  assert.equal(ok(VariableValue, 'a\0b'), false);

  assert.ok(ok(NetworkSecretValue, 'sk-test'));

  for (const value of ['', 'a\rb', 'a\nb', 'a\0b', 'a'.repeat(8193)]) {
    assert.equal(ok(NetworkSecretValue, value), false, JSON.stringify(value.slice(0, 8)));
  }
});

test('requests are strict and network secrets need 1 to 10 unique hosts', () => {
  assert.ok(SetVariableRequest.safeParse({ value: 'x' }).success);
  assert.equal(SetVariableRequest.safeParse({ value: 'x', extra: 1 }).success, false);

  const secret = SetNetworkSecretRequest.parse({ value: 'sk', hosts: ['api.openai.com'] });
  assert.equal(secret.header, 'Authorization');

  for (const hosts of [[], ['api.openai.com', 'api.openai.com'], Array.from({ length: 11 }, (_, i) => `h${i}.com`)]) {
    assert.equal(SetNetworkSecretRequest.safeParse({ value: 'sk', hosts }).success, false);
  }
});

test('the client view cannot carry a network value or placeholder', () => {
  const now = new Date().toISOString();
  const placeholder = `cloudswe_ph_OPENAI_API_KEY_${'0'.repeat(32)}`;

  const stored = StoredEnvironment.parse({
    name: 'dev',
    variables: { DATABASE_URL: { value: 'postgres://x', updatedAt: now, updatedBy: { kind: 'client' } } },
    networkSecrets: {
      OPENAI_API_KEY: {
        value: 'sk-real',
        placeholder,
        hosts: ['api.openai.com'],
        header: 'Authorization',
        updatedAt: now,
      },
    },
    receipts: {},
    createdAt: now,
    updatedAt: now,
  });

  const view = {
    name: stored.name,
    variables: stored.variables,
    networkSecrets: { OPENAI_API_KEY: { hosts: ['api.openai.com'], header: 'Authorization', updatedAt: now } },
    createdAt: now,
    updatedAt: now,
  };

  assert.ok(EnvironmentView.safeParse(view).success);

  for (const leak of [{ value: 'sk-real' }, { placeholder }]) {
    const networkSecrets = { OPENAI_API_KEY: { ...view.networkSecrets.OPENAI_API_KEY, ...leak } };
    assert.equal(EnvironmentView.safeParse({ ...view, networkSecrets }).success, false);
  }
});

test('a session request may name an environment', () => {
  const request = {
    operationId: crypto.randomUUID(),
    template: 'base',
    model: { provider: 'anthropic', id: 'm' },
  };

  assert.ok(CreateSessionRequest.safeParse(request).success);
  assert.ok(CreateSessionRequest.safeParse({ ...request, environment: 'dev' }).success);
  assert.equal(CreateSessionRequest.safeParse({ ...request, environment: 'Dev!' }).success, false);
});
