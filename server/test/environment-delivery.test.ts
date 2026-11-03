/**
 * Path: server/test/environment-delivery.test.ts
 * Used by: pnpm test.
 * Purpose: Environment variables reach agent commands through the env file: edits apply to the next command only, the file is rewritten only on change, a replay doesn't sync, and the agent's own edits are replay-safe.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { CreateSessionResponse, OperationReceipt, Session } from '@cloud-swe/protocol';
import { ListEnvironmentsResponse } from '@cloud-swe/protocol/environments';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { Request as WorkerRequest } from 'miniflare';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { putEnvironment, setVariable } from '../src/environments.ts';
import { sandboxFile } from './git-env.ts';
import { modelAnswer } from './model-answer.ts';
import { forwardOutbound, runtime } from './runtime.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

test('an agent edit replayed after a newer client edit changes nothing', async () => {
  const rows = new Map<string, unknown>();

  // SAFETY: each key holds what the code under test put there, so reads return the type it asks for.
  const storage = {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      rows.set(key, structuredClone(value));
    },
    delete: async (key: string) => rows.delete(key),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...rows].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
  };

  const session = { kind: 'session', sessionId: crypto.randomUUID() } as const;
  await putEnvironment(storage, 'dev');
  await setVariable(storage, 'dev', 'FOO', 'agent', session, 'call-1');
  await setVariable(storage, 'dev', 'FOO', 'client', { kind: 'client' });
  const replay = await setVariable(storage, 'dev', 'FOO', 'agent', session, 'call-1');
  assert.ok(!('error' in replay));
  assert.equal(replay.variables.FOO?.value, 'client');
  assert.deepEqual(replay.variables.FOO?.updatedBy, { kind: 'client' });
});

test('environment variables reach agent commands', { timeout: 120_000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'cloud-swe-env-delivery-'));
  const model = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
  const bash = (id: string, command: string) => ({ id, name: 'bash', arguments: { command } });

  const calls: Pick<ToolCall, 'id' | 'name' | 'arguments'>[][] = [
    [bash('a', 'echo "A=$FOO"')],
    [],
    [bash('b', 'echo started > started.txt; sleep 3; echo "B=$FOO"')],
    [],
    [bash('c', 'echo "C=$FOO"')],
    [],
    [{ id: 'set', name: 'set_environment_variable', arguments: { name: 'BAR', value: 'agent' } }],
    [bash('d', 'echo "BAR=$BAR FOO=$FOO"')],
    [],
    [bash('e', 'echo "E=$FOO"')],
    [],
  ];

  const bodies: string[] = [];
  const sandboxCalls: { route: string; body: string }[] = [];

  const dev = {
    outboundService: {
      type: 'fetcher' as const,
      handler: async (request: WorkerRequest) => {
        if (new URL(request.url).hostname === 'api.anthropic.com') {
          bodies.push(await request.text());

          return modelAnswer(model.id, calls.shift() ?? []);
        }

        sandboxCalls.push({
          route: new URL(request.url).pathname.split('/').at(-1) ?? '',
          body: await request.clone().text(),
        });

        return forwardOutbound(request);
      },
    },
  };

  const bindings = { MODEL_ID: model.id, ANTHROPIC_API_KEY: 'fake-key' };
  let mf = runtime(storage, bindings, dev);
  const headers = { Authorization: 'Bearer integration-test-personal-token', 'Content-Type': 'application/json' };

  try {
    let base = await mf.ready;

    const api = async (path: string, method = 'GET', body?: Json) => {
      const init: RequestInit = { method, headers };

      if (body !== undefined) init.body = JSON.stringify(body);

      return fetch(new URL(path, base), init);
    };

    const envWrites = () => sandboxCalls.filter((call) => call.route === 'file' && call.body.includes('env.json.next'));
    const lastOutput = () => toolResults(bodies.at(-1) ?? '').at(-1)?.output ?? '';

    await api('/v1/environments/dev', 'PUT', {});
    await api('/v1/environments/dev/variables/FOO', 'PUT', { value: 'one' });

    const created = await api('/v1/sessions', 'POST', {
      operationId: crypto.randomUUID(),
      template: 'base',
      environment: 'dev',
      model,
    });

    const session = CreateSessionResponse.parse(await created.json()).session;

    const send = async (text: string) => {
      const sent = await api(`/v1/sessions/${session.id}/messages`, 'POST', { operationId: crypto.randomUUID(), text });
      assert.equal(sent.status, 202, await sent.clone().text());
      const { runId } = OperationReceipt.parse(await sent.json());

      for (let attempt = 0; attempt < 600; attempt++) {
        const current = Session.parse(await (await api(`/v1/sessions/${session.id}`)).json());

        if (current.run.kind !== 'idle' && current.run.runId === runId && current.run.kind !== 'running') {
          assert.equal(current.run.kind, 'completed', JSON.stringify(current.run));

          return;
        }

        await setTimeout(50);
      }

      throw new Error('run did not settle');
    };

    await send('first');
    assert.match(lastOutput(), /A=one/);
    assert.equal(envWrites().length, 1);
    assert.match(bodies[0] ?? '', /This session uses the environment `dev`/);
    assert.match(bodies[0] ?? '', /Normal variables: `FOO`/);

    // An edit reaches the next command, but not one that is already running, even across a restart.
    await api('/v1/environments/dev/variables/FOO', 'PUT', { value: 'two' });
    // Handled now: it fails when the Worker stops below, before anything awaits it.
    const running = send('second').catch(() => undefined);

    for (let attempt = 0; !(await sandboxFile(session.workspace.id, 'started.txt')); attempt++) {
      assert.ok(attempt < 400, 'command b started');
      await setTimeout(50);
    }

    await api('/v1/environments/dev/variables/FOO', 'PUT', { value: 'three' });
    const writesBeforeRestart = envWrites().length;
    await mf.dispose();
    await running;
    mf = runtime(storage, bindings, dev);
    base = await mf.ready;

    // Reads start the restarted Thread, which resumes the run and reattaches to command b.
    for (let attempt = 0; !/B=/.test(lastOutput()); attempt++) {
      assert.ok(attempt < 600, 'command b reported after the restart');
      await api(`/v1/sessions/${session.id}`);
      await setTimeout(50);
    }

    assert.match(lastOutput(), /B=two/);
    assert.equal(writesBeforeRestart, 2);
    assert.equal(envWrites().length, 2, 'a replayed command reattaches without syncing');

    await send('third');
    assert.match(lastOutput(), /C=three/);
    assert.equal(envWrites().length, 3);

    await send('fourth');
    assert.match(lastOutput(), /BAR=agent FOO=three/);
    const { environments } = ListEnvironmentsResponse.parse(await (await api('/v1/environments')).json());
    assert.deepEqual(environments[0]?.variables.BAR?.updatedBy, { kind: 'session', sessionId: session.id });
    assert.match(bodies.at(-1) ?? '', /Normal variables: `BAR`, `FOO`|Normal variables: `FOO`, `BAR`/);

    // Nothing changed: the command dispatches with no file write or setup command.
    const before = sandboxCalls.length;
    await send('fifth');
    assert.match(lastOutput(), /E=three/);
    assert.equal(envWrites().length, 4);
    assert.deepEqual(
      sandboxCalls.slice(before).filter((call) => call.route === 'exec'),
      [],
      'an unchanged environment makes no setup call',
    );
  } finally {
    await mf.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});
