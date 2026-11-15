/**
 * Path: server/test/environment-delivery.test.ts
 * Used by: pnpm test.
 * Purpose: Environment variables reach agent commands through the env file: edits apply to the next command only, the file is rewritten only on change, a replay doesn't sync, and the agent's own edits are replay-safe.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { SessionId } from '@cloud-swe/protocol';
import { ListEnvironmentsResponse } from '@cloud-swe/protocol/environments';

import { putEnvironment, setVariable } from '../src/environments.ts';
import { memoryStorage } from './fakes.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { toolResults } from './provider-request.ts';
import { type Call, model, sandboxFile, waitFor } from './rig.ts';

test('an agent edit replayed after a newer client edit changes nothing', async () => {
  const storage = memoryStorage();

  const session = { kind: 'session', sessionId: SessionId.parse(crypto.randomUUID()) } as const;
  await putEnvironment(storage, 'dev');
  await setVariable(storage, 'dev', 'FOO', 'agent', session, 'call-1');
  await setVariable(storage, 'dev', 'FOO', 'client', { kind: 'client' });
  const replay = await setVariable(storage, 'dev', 'FOO', 'agent', session, 'call-1');
  assert.ok(!('error' in replay));
  assert.equal(replay.variables.FOO?.value, 'client');
  assert.deepEqual(replay.variables.FOO?.updatedBy, { kind: 'client' });
});

test('environment variables reach agent commands', { timeout: 120_000 }, async (t) => {
  const rig = await lifecycleRig();
  const bash = (id: string, command: string) => ({ id, name: 'bash', arguments: { command } });

  const calls: Call[][] = [
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
    [bash('f', 'sleep 1; echo "SLOW=$FOO"')],
    [],
  ];

  let delaySync = false;
  rig.setAnswer(() => modelAnswer(model.id, calls.shift() ?? []));
  rig.setIntercept(async ({ path }) => {
    if (delaySync && path.endsWith('/exec')) {
      delaySync = false;
      // The setup command's own timeout is 30 s, so this is a slow but valid apply.
      await setTimeout(16_000);
    }

    return undefined;
  });

  try {
    const { bodies } = rig;
    const api = (path: string, method?: string, body?: Record<string, string>) => rig.api(path, body, method);
    const route = (path: string) => path.split('/').at(-1) ?? '';

    const envWrites = () =>
      rig.log.filter((call) => route(call.path) === 'file' && call.body.includes('env.json.next'));

    const lastOutput = () => toolResults(bodies.at(-1) ?? '').at(-1)?.output ?? '';

    await api('/v1/environments/dev', 'PUT', {});
    await api('/v1/environments/dev/variables/FOO', 'PUT', { value: 'one' });

    const session = await rig.create('dev');

    const send = async (text: string) => {
      const { runId } = await rig.accepted(await rig.send(session.id, text));

      const current = await waitFor(
        () => rig.session(session.id),
        ({ run }) => run.kind !== 'idle' && run.runId === runId && run.kind !== 'running',
      );

      assert.equal(current.run.kind, 'completed', JSON.stringify(current.run));
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

    await waitFor(() => sandboxFile(session.workspace.id, 'started.txt'));

    await api('/v1/environments/dev/variables/FOO', 'PUT', { value: 'three' });
    const writesBeforeRestart = envWrites().length;
    await rig.restart();
    await running;

    // Reads start the restarted Thread, which resumes the run and reattaches to command b.
    await waitFor(
      () => api(`/v1/sessions/${session.id}`),
      () => /B=/.test(lastOutput()),
    );

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
    assert.match(bodies.at(-1) ?? '', /Normal variables: `FOO`, `BAR`\./);

    // Nothing changed: the command dispatches with no file write or setup command.
    const before = rig.log.length;
    await send('fifth');
    assert.match(lastOutput(), /E=three/);
    assert.equal(envWrites().length, 4);
    assert.deepEqual(
      rig.log.slice(before).filter((call) => route(call.path) === 'exec'),
      [],
      'an unchanged environment makes no setup call',
    );

    await t.test('a slow sync does not count against the fresh command', async () => {
      await api('/v1/environments/dev/variables/FOO', 'PUT', { value: 'slow' });
      delaySync = true;
      await send('sixth');
      const result = toolResults(bodies.at(-1) ?? '').at(-1);

      assert.notEqual(result?.isError, true, result?.output);
      assert.match(result?.output ?? '', /SLOW=slow/);
    });
  } finally {
    await rig.close();
  }
});
