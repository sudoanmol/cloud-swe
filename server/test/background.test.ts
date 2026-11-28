/**
 * Path: server/test/background.test.ts
 * Used by: pnpm test.
 * Purpose: Background commands on the Docker sandbox: they outlive their run, are refreshed only when something looks, read in byte slices, stop with their process group, respect the limit, and end truthfully when their supervisor or sandbox goes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { ApiError, type Session } from '@cloud-swe/protocol';
import { BackgroundCommand, BackgroundOutput } from '@cloud-swe/protocol/background';

import { IDLE_TTL_SECONDS } from '../src/workspaces/settings.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';
import { toolResults } from './provider-request.ts';
import { type Call, model, sandboxFile, sandboxRun, waitFor } from './rig.ts';
import { DockerTtl } from './sandbox-tools.ts';

const KEEPALIVE = { KEEPALIVE_INTERVAL_SECONDS: '1' };

type Rig = Awaited<ReturnType<typeof lifecycleRig>>;

const call = (name: string, args: Call['arguments']): Call => ({ id: crypto.randomUUID(), name, arguments: args });

const background = (command: string) => call('bash_background', { command });

/** The scripted model answers each request with the next step's calls, then with plain text. */
function script(rig: Rig, ...steps: Call[][]) {
  rig.setAnswer(() => modelAnswer(model.id, steps.shift() ?? []));
}

const commands = async (rig: Rig, id: string) => (await rig.session(id)).backgroundCommands;

const commandPath = (session: Session, commandId: string) =>
  `/v1/sessions/${session.id}/background-commands/${commandId}`;

async function output(rig: Rig, session: Session, commandId: string, offset?: number) {
  const response = await rig.api(
    `${commandPath(session, commandId)}/output${offset === undefined ? '' : `?offset=${offset}`}`,
  );

  assert.equal(response.status, 200, await response.clone().text());

  return BackgroundOutput.parse(await response.json());
}

async function stop(rig: Rig, session: Session, commandId: string) {
  const response = await rig.api(`${commandPath(session, commandId)}/stop`, {});
  assert.equal(response.status, 200, await response.clone().text());

  return BackgroundCommand.parse(await response.json());
}

const lastResults = (rig: Rig) => toolResults(rig.bodies.at(-1) ?? '');

/** Sends a message whose run makes the scripted calls, and waits for the run to end. */
async function run(rig: Rig, session: Session, ...steps: Call[][]) {
  script(rig, ...steps);
  await rig.accepted(await rig.send(session.id, 'go'));
  const done = await rig.settled(session.id);
  assert.equal(done.run.kind, 'completed', JSON.stringify(done.run));

  return done;
}

/** Reads of a command's progress file in the sandbox, which only a refresh makes. */
const progressReads = (rig: Rig, commandId: string) =>
  rig.log.filter(
    ({ method, path, search }) => method === 'GET' && path.endsWith('/file') && search.includes(commandId),
  );

/** The PIDs among `pids` that are still alive (zombies count as dead). */
async function alive(workspaceId: string, pids: string[]) {
  const script = `for p in ${pids.join(' ')}; do if [ -e /proc/$p ] && ! grep -q 'State:.*Z' /proc/$p/status; then echo $p; fi; done`;
  const { output } = await sandboxRun(workspaceId, script);

  return output.split('\n').filter(Boolean);
}

const pidsOf = async (workspaceId: string, ...files: string[]) =>
  Promise.all(files.map(async (file) => (await waitFor(() => sandboxFile(workspaceId, file))).trim()));

// "line-1\n" to "line-12000\n" then "ready\n": about 117 KB, past the 64 KB live window.
const LINES = Array.from({ length: 12_000 }, (_, index) => `line-${index + 1}\n`).join('') + 'ready\n';

test(
  'a background command outlives its run, is refreshed by every keep-alive tick and by nothing after, and reads in byte slices',
  { timeout: 90_000 },
  async () => {
    const rig = await lifecycleRig(KEEPALIVE);

    try {
      const session = await rig.create();
      const id = session.workspace.id;
      const start = background(`seq 1 12000 | sed 's/^/line-/'; echo ready; exec sleep 600`);
      const quick = background('sleep 1.5; echo done');

      // The second command exits while the run is still busy, and a tick sees it without any tool looking.
      const stream = await rig.events(session.id);
      script(rig, [start], [quick], [call('bash', { command: 'sleep 4' })]);
      await rig.accepted(await rig.send(session.id, 'go'));

      const during = await stream.until((snapshot) =>
        snapshot.session.backgroundCommands.some((command) => command.state === 'exited'),
      );

      assert.equal(during.session.run.kind, 'running', 'a keep-alive tick saw the exit during the run');
      await stream.close();

      const done = await rig.settled(session.id);
      assert.equal(done.run.kind, 'completed');
      const [first] = lastResults(rig);
      assert.match(first?.output ?? '', /^Background command [0-9a-f-]{36}: (running|starting)/);
      const [exited, running] = await commands(rig, session.id);
      assert.equal(exited?.state, 'exited');
      assert.equal(running?.state, 'running');
      assert.ok(running);

      // The run's final tick refreshes the command once more, then nothing reads the sandbox again.
      const ttls = () =>
        rig.log.flatMap(({ method, path, body }, index) =>
          method === 'POST' &&
          path.endsWith('/ttl') &&
          DockerTtl.parse(JSON.parse(body)).ttlSeconds === IDLE_TTL_SECONDS
            ? [index]
            : [],
        );

      const final = await waitFor(ttls, (list) => list.length > 0);
      const after = () => progressReads(rig, running.id).filter((read) => rig.log.indexOf(read) > (final[0] ?? 0));
      await waitFor(after, (reads) => reads.length > 0);
      const settledReads = progressReads(rig, running.id).length;
      const resumes = rig.requests('POST', /\/resume$/).length;
      await setTimeout(3000);
      assert.equal(progressReads(rig, running.id).length, settledReads, 'nothing polls a background command');
      assert.equal(rig.requests('POST', /\/resume$/).length, resumes, 'nor keeps its sandbox awake');
      assert.notEqual((await commands(rig, session.id))[1]?.checkedAt, null);

      // Live reads: the window holds the newest 64 KB, and offsets slice it exactly.
      const whole = await waitFor(
        () => output(rig, session, running.id),
        (read) => read.outputBytes === LINES.length,
      );

      assert.equal(whole.live, true);
      assert.equal(whole.command.state, 'running', 'still running long after its run ended');
      assert.equal(whole.offset + whole.text.length, LINES.length);
      assert.equal(whole.skippedBytes, whole.offset);
      assert.ok(whole.skippedBytes > 0);
      assert.equal(whole.text, LINES.slice(whole.offset));

      const tail = await output(rig, session, running.id, LINES.length - 100);
      assert.deepEqual([tail.offset, tail.skippedBytes, tail.text], [LINES.length - 100, 0, LINES.slice(-100)]);
      assert.equal((await output(rig, session, running.id, LINES.length)).text, '');

      // Asleep, a read returns the saved tail and never touches the sandbox.
      await rig.sandbox(id, '/stop', '{}');
      const before = rig.log.length;
      const saved = await output(rig, session, running.id);
      assert.equal(saved.live, false);
      assert.ok(saved.text.length > 0 && saved.text.length <= 8192 && LINES.endsWith(saved.text));
      assert.equal(saved.offset, LINES.length - saved.text.length);
      assert.deepEqual(
        rig.log.slice(before).filter(({ path }) => path.endsWith('/file') || path.endsWith('/resume')),
        [],
      );
      assert.equal(await rig.boxState(id), 'stopped');

      const missing = await rig.api(`${commandPath(session, crypto.randomUUID())}/output`);
      assert.equal(missing.status, 404);
      assert.equal(ApiError.parse(await missing.json()).error.code, 'background_command_not_found');
    } finally {
      await rig.close();
    }
  },
);

test(
  'cancelling a run leaves its commands running; a stop by the route or bash_stop ends the process group, and a stop while asleep happens at the next wake-up',
  { timeout: 90_000 },
  async () => {
    const rig = await lifecycleRig(KEEPALIVE);

    try {
      const session = await rig.create();
      const id = session.workspace.id;
      const group = (name: string) => `echo $$ > ${name}.pid; sleep 600 & echo $! > ${name}-child.pid; wait`;

      script(rig, [background(group('a')), background(group('b'))], [call('bash', { command: 'sleep 30' })]);
      const receipt = await rig.accepted(await rig.send(session.id, 'go'));
      await waitFor(
        () => rig.session(session.id),
        (s) => s.backgroundCommands.length === 2 && s.backgroundCommands.every(({ state }) => state === 'running'),
      );

      const cancel = await rig.api(rig.conversation(session.id) + '/cancel', {
        operationId: crypto.randomUUID(),
        runId: receipt.runId,
      });

      assert.equal(cancel.status, 202, await cancel.clone().text());
      assert.equal((await rig.settled(session.id)).run.kind, 'cancelled');

      const [b, a] = await commands(rig, session.id);
      assert.ok(a && b);
      assert.equal((await output(rig, session, a.id)).command.state, 'running', 'cancelling a run stops none');
      const aPids = await pidsOf(id, 'a.pid', 'a-child.pid');
      const bPids = await pidsOf(id, 'b.pid', 'b-child.pid');
      assert.deepEqual(await alive(id, [...aPids, ...bPids]), [...aPids, ...bPids]);

      const stopped = await stop(rig, session, a.id);
      assert.equal(stopped.state, 'exited');

      if (stopped.state === 'exited') assert.deepEqual([stopped.termination, stopped.stoppedBy], ['stopped', 'user']);
      assert.deepEqual(await alive(id, aPids), [], 'the shell and its child are gone');
      assert.deepEqual(await stop(rig, session, a.id), stopped, 'a second stop changes nothing');

      await run(rig, session, [call('bash_stop', { id: b.id })]);
      assert.match(lastResults(rig).at(-1)?.output ?? '', /stopped by the agent/);
      const agentStopped = (await commands(rig, session.id)).find((command) => command.id === b.id);
      assert.equal(agentStopped?.state === 'exited' && agentStopped.stoppedBy, 'agent');
      assert.deepEqual(await alive(id, bPids), []);

      // Asleep: the stop is marked without waking the sandbox, and happens when the next message wakes it.
      await run(rig, session, [background('echo $$ > c.pid; exec sleep 600')]);
      const [asleep] = await commands(rig, session.id);
      assert.ok(asleep);
      const cPids = await pidsOf(id, 'c.pid');
      await rig.sandbox(id, '/stop', '{}');
      const before = rig.log.length;
      const marked = await stop(rig, session, asleep.id);
      assert.deepEqual(marked.state === 'running' && marked.stopping, true, 'the stop is waiting for a wake-up');
      assert.deepEqual(
        rig.log.slice(before).filter(({ path }) => path.endsWith('/resume') || path.endsWith('/file')),
        [],
        'and never touched the sandbox',
      );
      assert.equal(await rig.boxState(id), 'stopped');

      await run(rig, session);

      const ended = await waitFor(
        () => output(rig, session, asleep.id),
        (read) => read.command.state === 'exited',
      );

      assert.deepEqual(ended.command.state === 'exited' && [ended.command.termination, ended.command.stoppedBy], [
        'stopped',
        'user',
      ]);
      assert.deepEqual(await alive(id, cPids), []);

      const missing = await rig.api(`${commandPath(session, crypto.randomUUID())}/stop`, {});
      assert.equal(missing.status, 404);
    } finally {
      await rig.close();
    }
  },
);

test(
  'nine parallel starts leave eight running and one refusal; code mode starts one; bash_output lists and reads from an offset; a timeout ends one; the 20 newest ended are kept',
  { timeout: 90_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();
      await run(
        rig,
        session,
        Array.from({ length: 9 }, () => background('sleep 600')),
      );
      const results = lastResults(rig);
      assert.equal(results.length, 9);
      assert.equal(results.filter((result) => result.isError).length, 1);
      assert.match(results.find((result) => result.isError)?.output ?? '', /8 background commands are already running/);
      const listed = await commands(rig, session.id);
      assert.equal(listed.length, 8);
      assert.ok(listed.every(({ state }) => state === 'running' || state === 'starting'));

      const other = await rig.create();
      const code = `return await tools.bash_background({command: 'sleep 600'});`;
      await run(rig, other, [call('codemode', { code })]);
      assert.match(lastResults(rig).at(-1)?.output ?? '', /Background command/);
      const [started] = await commands(rig, other.id);
      assert.ok(started);
      assert.equal((await output(rig, other, started.id)).command.state, 'running');

      // bash_output lists the commands, and reads from a byte offset.
      await run(rig, other, [call('bash_output', {})]);
      assert.match(lastResults(rig).at(-1)?.output ?? '', new RegExp(`${started.id} — running`));
      await run(rig, other, [background('printf abcdef; exec sleep 600')]);
      const [printer] = await commands(rig, other.id);
      assert.ok(printer);

      await waitFor(
        () => output(rig, other, printer.id),
        (read) => read.outputBytes === 6,
      );

      await run(rig, other, [call('bash_output', { id: printer.id, offset: 2 })]);
      assert.match(lastResults(rig).at(-1)?.output ?? '', /Output bytes 2–6 of 6\.\ncdef\nNext offset: 6$/);

      // A timeout ends a command as timed out.
      await run(rig, other, [call('bash_background', { command: 'sleep 30', timeout: 1 })]);
      const [timed] = await commands(rig, other.id);
      assert.ok(timed);

      const expired = await waitFor(
        () => output(rig, other, timed.id),
        (read) => read.command.state === 'exited',
      );

      assert.equal(expired.command.state === 'exited' && expired.command.termination, 'timeout');

      // 24 commands end, and the session keeps the 20 newest.
      const busy = await rig.create();

      for (let round = 0; round < 3; round++) {
        await run(
          rig,
          busy,
          Array.from({ length: 8 }, () => background('true')),
        );

        for (const { id } of (await commands(rig, busy.id)).filter(({ state }) => state !== 'exited')) {
          await waitFor(
            () => output(rig, busy, id),
            (read) => read.command.state === 'exited',
          );
        }
      }

      assert.equal((await commands(rig, busy.id)).length, 20);
    } finally {
      await rig.close();
    }
  },
);

test(
  'a start whose dispatch never arrived never runs and ends lost; a Worker restart keeps tracking a running one',
  { timeout: 90_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();
      let dropped = 0;

      rig.setIntercept(({ path, body }) => {
        if (!path.endsWith('/commands') || !body.includes('counter.txt')) return undefined;
        dropped++;

        return new Response('lost before it ran', { status: 503 });
      });

      await run(rig, session, [background('echo ran >> counter.txt')]);
      assert.equal(dropped, 1);
      assert.match(lastResults(rig).at(-1)?.output ?? '', /starting/);
      const [unconfirmed] = await commands(rig, session.id);
      assert.ok(unconfirmed);

      // One look, long after the limit, as the app's or a keep-alive tick's would be: looks are far apart.
      await setTimeout(16_000);
      const lost = await output(rig, session, unconfirmed.id);

      assert.match(lost.command.state === 'lost' ? lost.command.reason : '', /couldn't be confirmed/);
      assert.equal(await sandboxFile(session.workspace.id, 'counter.txt'), undefined, 'it never ran');
      assert.equal(dropped, 1, 'and was never sent again');

      await run(rig, session, [background('sleep 3; echo finished')]);
      const [later] = await commands(rig, session.id);
      assert.ok(later);
      await rig.restart();

      const finished = await waitFor(
        () => output(rig, session, later.id),
        (read) => read.command.state === 'exited',
      );

      assert.equal(finished.command.state === 'exited' && finished.command.exitCode, 0);
      assert.equal(finished.text, 'finished\n');
    } finally {
      await rig.close();
    }
  },
);

test(
  'a long pause is not silence, a killed supervisor ends its command lost, and a deleted sandbox ends it with a notice to the agent',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();
      const id = session.workspace.id;
      await run(rig, session, [background('while true; do echo tick; sleep 0.2; done')]);
      const [ticking] = await commands(rig, session.id);
      assert.ok(ticking);
      await output(rig, session, ticking.id);

      await rig.sandbox(id, '/stop', '{}');
      await setTimeout(16_000);
      const asleep = await output(rig, session, ticking.id);
      assert.equal(asleep.live, false);

      // A message wakes it, as in real use; its keep-alive tick is the first look after the gap.
      await run(rig, session);
      const resumed = await output(rig, session, ticking.id);
      assert.deepEqual([resumed.live, resumed.command.state], [true, 'running'], 'a wake-up after 16 s is not silence');
      await setTimeout(1000);
      const growing = await output(rig, session, ticking.id);
      assert.equal(growing.command.state, 'running');
      assert.ok(growing.outputBytes > asleep.outputBytes, 'and the command continued');

      // The image has no pkill. The supervisor's command line holds its script, newlines included; the bracket keeps
      // this script's own command line from matching.
      const supervisor = `[i]nput-type=module.*${ticking.id}`;

      const kill = await sandboxRun(
        id,
        `for d in /proc/[0-9]*; do tr '\\0\\n' '  ' < $d/cmdline 2>/dev/null | grep -q '${supervisor}' && kill -9 \${d#/proc/} && echo killed; done`,
      );

      assert.match(kill.output, /killed/);

      await setTimeout(16_000);
      const silent = await output(rig, session, ticking.id);

      assert.match(silent.command.state === 'lost' ? silent.command.reason : '', /stopped reporting/);

      await run(rig, session, [background('sleep 600 # the server')]);
      const [server] = await commands(rig, session.id);
      assert.ok(server);

      const deleted = await fetch(new URL(`/workspaces/${id}`, process.env.DOCKER_SANDBOX_URL), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + process.env.DOCKER_SANDBOX_TOKEN },
      });

      assert.equal(deleted.status, 200);

      // Reading its output finds the sandbox gone and ends it, before any message replaces the sandbox.
      const ended = (await output(rig, session, server.id)).command;
      assert.equal(ended.state, 'lost');
      assert.match(ended.state === 'lost' ? ended.reason : '', /sandbox was deleted/);

      // The next message replaces the sandbox, and the agent still hears which commands ended with it.
      await run(rig, session);
      const notice = rig.bodies.find((body) => body.includes('ended with the old sandbox'));
      assert.ok(notice?.includes(`sleep 600 # the server (background command ${server.id})`));
    } finally {
      await rig.close();
    }
  },
);
