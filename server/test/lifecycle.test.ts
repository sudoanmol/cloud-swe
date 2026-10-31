import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { ApiError, CommandIdentity, CreateSessionResponse } from '@cloud-swe/protocol';
import { FileContent, ShellProgress } from '@cloud-swe/protocol/tools';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { NOTICE_KIND } from '../src/sessions/notice.ts';
import { DockerCommand, DockerTtl } from '../src/workspaces/docker.ts';
import { lifecycleRig } from './lifecycle-rig.ts';

const NOTICE = 'Your previous sandbox was deleted after a long period of inactivity';

const occurrences = (text: string, part: string) => text.split(part).length - 1;

test(
  'keep-alive renews while a run is active, shortens the deadline once when it ends, and the sandbox outlives its ttl',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig({ KEEPALIVE_INTERVAL_SECONDS: '1' });

    try {
      const session = await rig.create();
      const id = session.workspace.id;

      // The double stops a sandbox at its deadline, as Boat does. Only renewals keep this one alive past 2 s.
      await rig.sandbox(id, '/ttl', JSON.stringify({ ttlSeconds: 2 }));
      let failed = false;

      rig.setIntercept(({ path, body }) => {
        if (!path.endsWith('/ttl') || !body.includes('"ttlSeconds":600') || failed) return undefined;
        failed = true;

        return new Response('boom', { status: 503 });
      });

      await rig.accepted(await rig.send(session.id, 'run', undefined, rig.bash('sleep 6; printf alive')));
      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
      assert.match(toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '', /alive/);

      const ttls = async () =>
        rig.requests('POST', /\/ttl$/).map(({ body }) => DockerTtl.parse(JSON.parse(body)).ttlSeconds);

      // The final renewal fails once and is retried by the same job.
      await rig.until(ttls, (list) => list.filter((ttl) => ttl === 600).length >= 2);
      const list = await ttls();
      assert.deepEqual(list.slice(-2), [600, 600]);
      assert.ok(list.slice(0, -2).length >= 4 && list.slice(0, -2).every((ttl) => ttl === 3), 'renewed every second');

      await setTimeout(3000);
      assert.equal((await ttls()).length, list.length, 'the job stops once the run has ended and the deadline is set');
      assert.equal(await rig.boxState(id), 'running');
    } finally {
      await rig.close();
    }
  },
);

test(
  'a sandbox that stops mid-run ends the command as interrupted, shows stopped, and the next message resumes it',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();
      const id = session.workspace.id;
      await rig.accepted(
        await rig.send(session.id, 'go', undefined, rig.bash('printf started; sleep 30; printf survived')),
      );
      await rig.until(
        async () => rig.requests('POST', /\/commands$/).length,
        (count) => count >= 1,
      );
      await setTimeout(600);
      await rig.sandbox(id, '/stop', '{}');

      const done = await rig.settled(session.id);
      assert.equal(done.run.kind, 'completed', 'the command ended, so the run is not left uncertain');
      const result = toolResults(rig.bodies.at(-1) ?? '').at(-1);
      assert.equal(result?.isError, true);
      assert.match(result?.output ?? '', /sandbox stopped/);

      const stopped = await rig.until(
        () => rig.session(session.id),
        (s) => s.workspace.state === 'stopped',
      );

      assert.equal(stopped.workspace.state, 'stopped');

      const pending = rig.send(session.id, 'again', undefined, rig.bash('printf resumed'));

      const starting = await rig.until(
        () => rig.session(session.id),
        (s) => s.workspace.state === 'starting',
      );

      assert.equal(starting.workspace.state, 'starting', 'reported while the sandbox boots');

      await rig.accepted(await pending);
      assert.equal(
        (
          await rig.until(
            () => rig.session(session.id),
            (s) => s.run.kind === 'completed',
          )
        ).run.kind,
        'completed',
      );
      assert.match(toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '', /resumed/);
      assert.equal((await rig.session(session.id)).workspace.state, 'running');
      assert.equal(rig.requests('POST', /\/resume$/).length, 1);
      assert.ok(
        rig.bodies.every((body) => !body.includes(NOTICE)),
        'an ordinary resume carries no notice',
      );
    } finally {
      await rig.close();
    }
  },
);

test(
  'MAX_SANDBOXES counts running sandboxes only; creation fails fast and a resume waits for a slot',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig({ MAX_SANDBOXES: '2' });

    try {
      const firstOperation = crypto.randomUUID();
      const first = CreateSessionResponse.parse(await (await rig.createResponse(firstOperation)).json()).session;
      const second = await rig.create();

      const before = rig.log.length;
      const rejected = await rig.createResponse();
      assert.equal(rejected.status, 409);

      const error = ApiError.parse(await rejected.json()).error;
      assert.equal(error.code, 'sandbox_limit_reached');
      assert.equal(
        error.message,
        "You've reached your limit of 2 running sandboxes. Wait for one to stop, then try again.",
      );
      assert.deepEqual(
        rig.log.slice(before).filter(({ method }) => method !== 'GET'),
        [],
        'nothing is created or changed on rejection; only state reads happen',
      );

      const replay = await rig.createResponse(firstOperation);
      assert.equal(replay.status, 200, 'an admitted operation still returns its session at the cap');
      assert.equal(CreateSessionResponse.parse(await replay.json()).session.id, first.id);

      // Stopped sandboxes never block a new session, even though the catalog last saw them running.
      await rig.sandbox(first.workspace.id, '/stop', '{}');
      const third = await rig.create();
      assert.equal(rig.requests('PUT', /^\/workspaces\/[^/]+$/).length, 3);

      const blocked = await rig.send(first.id, 'wake up');
      assert.equal(blocked.status, 409);
      assert.equal(ApiError.parse(await blocked.json()).error.code, 'sandbox_limit_reached');
      assert.equal(rig.requests('POST', /\/resume$/).length, 0, 'no resume was attempted');
      assert.equal((await rig.session(first.id)).workspace.state, 'stopped');

      await rig.sandbox(second.workspace.id, '/stop', '{}');
      await rig.accepted(await rig.send(first.id, 'wake up'));
      assert.equal(rig.requests('POST', /\/resume$/).length, 1);
      assert.equal(third.workspace.state, 'running');
    } finally {
      await rig.close();
    }
  },
);

test(
  'a deleted sandbox is replaced once, the model gets one notice that clients never see, and retries do not provision twice',
  { timeout: 90_000 },
  async () => {
    const rig = await lifecycleRig({ SANDBOX_DELETE_AFTER_DAYS: '0.0001' });

    try {
      const session = await rig.create();
      const oldId = session.workspace.id;

      // The catalog's alarm deletes a sandbox that saw no activity for the configured time.
      assert.equal(
        await rig.until(
          () => rig.boxState(oldId),
          (state) => state === 'deleted',
          600,
        ),
        'deleted',
      );

      const view = await rig.until(
        () => rig.session(session.id),
        (s) => s.workspace.state === 'deleted',
      );

      assert.equal(view.workspace.state, 'deleted');

      const operationId = crypto.randomUUID();

      const [one, two] = await Promise.all([
        rig.send(session.id, 'continue', operationId),
        rig.send(session.id, 'continue', operationId),
      ]);

      const receipt = await rig.accepted(one);
      assert.deepEqual(await rig.accepted(two), receipt);
      await rig.until(
        () => rig.session(session.id),
        (s) => s.run.kind === 'completed',
      );

      const replaced = await rig.session(session.id);
      assert.notEqual(replaced.workspace.id, oldId);
      assert.equal(replaced.workspace.state, 'running');
      assert.equal(await rig.boxState(replaced.workspace.id), 'running');
      assert.equal(rig.requests('PUT', /^\/workspaces\/[^/]+$/).length, 2, 'one creation and one replacement');

      const carrying = rig.bodies.filter((body) => body.includes(NOTICE));
      assert.equal(carrying.length, 1);
      assert.equal(occurrences(carrying[0] ?? '', NOTICE), 1);

      for (const text of [
        JSON.stringify(await rig.snapshot(session.id)),
        JSON.stringify(await rig.history(session.id)),
      ]) {
        assert.ok(!text.includes(NOTICE), 'the notice never reaches a client view');
      }

      const entries = (await rig.history(session.id)).entries;
      assert.equal(entries.filter((e) => e.kind === 'native' && e.nativeKind === NOTICE_KIND).length, 1);
      const users = entries.flatMap((e) => (e.kind === 'message' && e.role === 'user' ? [e.content] : []));
      assert.deepEqual(users, [[{ kind: 'text', text: 'continue' }]], 'the user message is exactly what was sent');

      // A retry of the admitted message is a receipt lookup, and ordinary follow-ups carry no second notice.
      const bodies = rig.bodies.length;
      assert.deepEqual(await rig.accepted(await rig.send(session.id, 'continue', operationId)), receipt);
      assert.equal(rig.bodies.length, bodies);
      await rig.accepted(await rig.send(session.id, 'and more'));
      await rig.until(
        () => rig.session(session.id),
        (s) => s.run.kind === 'completed' && rig.bodies.length > bodies,
      );
      assert.equal(rig.requests('PUT', /^\/workspaces\/[^/]+$/).length, 2);
      assert.equal(
        (await rig.history(session.id)).entries.filter((e) => e.kind === 'native' && e.nativeKind === NOTICE_KIND)
          .length,
        1,
      );
    } finally {
      await rig.close();
    }
  },
);

test(
  'an orphaned command is stopped by the reconcile job after a Worker restart, with no client request',
  { timeout: 90_000 },
  async () => {
    const rig = await lifecycleRig();

    try {
      const session = await rig.create();
      let blockStop = true;

      rig.setIntercept(({ path, body }) =>
        blockStop && path.endsWith('/file') && body.includes('.cancel')
          ? new Response('sandbox unreachable', { status: 503 })
          : undefined,
      );

      const started = await rig.accepted(
        await rig.send(session.id, 'go', undefined, rig.bash('printf started; sleep 30; printf must-not-survive')),
      );

      const dispatched = await rig.until(async () => rig.requests('POST', /\/commands$/)[0], Boolean);
      const { command } = DockerCommand.parse(JSON.parse(dispatched?.body ?? 'null'));

      const identity = CommandIdentity.parse({
        workspaceId: /"workspaceId":"([a-f0-9-]+)"/.exec(command)?.[1],
        operationId: /"operationId":"([a-f0-9-]+)"/.exec(command)?.[1],
      });

      await setTimeout(500);

      const cancelled = await rig.api(`/v1/sessions/${session.id}/cancel`, {
        operationId: crypto.randomUUID(),
        runId: started.runId,
      });

      assert.equal(cancelled.status, 503, 'the stop marker could not be written, so the command is orphaned');

      blockStop = false;
      await rig.restart();

      const progress = async () => {
        const path = `/tmp/cloud-swe-${identity.workspaceId}-${identity.operationId}.json`;
        const response = await rig.sandbox(identity.workspaceId, `/file?path=${encodeURIComponent(path)}`);

        return response.ok
          ? ShellProgress.parse(JSON.parse(FileContent.parse(await response.json()).content))
          : undefined;
      };

      const final = await rig.until(progress, (value) => value?.kind === 'exited', 600);
      assert.equal(final?.kind === 'exited' ? final.termination : final?.kind, 'cancelled');
    } finally {
      await rig.close();
    }
  },
);
