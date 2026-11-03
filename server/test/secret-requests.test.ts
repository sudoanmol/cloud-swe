/**
 * Path: server/test/secret-requests.test.ts
 * Used by: pnpm test.
 * Purpose: request_network_secret: the user's value goes to the environment and never into Thread storage, Pi records or SSE; the outcome reaches the agent; the next command gets the placeholder and the proxy swaps it; a cancellation withdraws a queued outcome.
 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { CancelRunResponse } from '@cloud-swe/protocol';
import { SecretRequest } from '@cloud-swe/protocol/environments';
import type { ToolCall } from '@earendil-works/pi-ai';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { lifecycleRig } from './lifecycle-rig.ts';
import { modelAnswer } from './model-answer.ts';

const MODEL = 'claude-sonnet-5-5';
const HOST = 'api.fakeprovider.test';
const SECRET = 'sk-requested-real-value';

const ask = (name: string) => ({
  id: crypto.randomUUID(),
  name: 'request_network_secret',
  arguments: { name, hosts: [HOST], reason: 'To call the provider in the tests' },
});

type Call = Pick<ToolCall, 'id' | 'name' | 'arguments'>;

/** A rig whose model follows a script, with the root setup answered and the daemon's config kept. */
async function secretRig() {
  const rig = await lifecycleRig();
  const script: Call[][] = [];
  let egress: { token: string } | undefined;

  rig.setAnswer(() => modelAnswer(MODEL, script.shift() ?? []));

  rig.setIntercept(async (request) => {
    if (request.host === HOST) {
      return new Response(request.authorization === `Bearer ${SECRET}` ? 'real-key' : 'wrong-key');
    }

    if (request.method !== 'POST' || !/\/(file|exec)$/.test(request.path)) return undefined;
    const body = JSON.parse(request.body);

    // The plain double can't run root setup, so it is answered here.
    if (body.user !== 'root') return undefined;

    if (String(body.path).endsWith('egress.json.next')) egress = JSON.parse(body.content);

    if (request.path.endsWith('/file')) return Response.json({ written: true });
    // The env file's own move needs no root; run that line for real, so commands see the placeholder.

    const moveEnv = String(body.command)
      .split('\n')
      .find((line) => line.includes('.cloud-swe/env.json.next'));

    const id = request.path.split('/')[2] ?? '';
    await rig.sandbox(id, '/exec', JSON.stringify({ command: moveEnv, timeoutMs: 30_000 }));

    return Response.json({ exitCode: 0, stdout: 'applied\n' });
  });

  await rig.api('/v1/environments/dev', {}, 'PUT');

  return { rig, script, token: () => egress?.token };
}

test('a requested network secret reaches the environment, never the Thread', { timeout: 120_000 }, async () => {
  const { rig, script, token } = await secretRig();

  try {
    const session = await rig.create('dev');
    const path = `/v1/sessions/${session.id}`;

    const answer = (id: string, body: Record<string, string | string[]> | { decline: true }) =>
      rig.api(`${path}/secret-requests/${id}`, body);

    script.push([ask('STRIPE_KEY')], []);
    await rig.accepted(await rig.send(session.id, 'Use Stripe'));
    const asked = await rig.settled(session.id);
    assert.match(toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '', /sent to the user/);
    const [request] = asked.secretRequests;
    assert.equal(request?.state, 'pending');
    assert.deepEqual(request.hosts, [HOST]);
    assert.equal(request.header, 'Authorization');

    assert.equal((await answer(crypto.randomUUID(), { decline: true })).status, 404);
    assert.equal((await answer(request.id, { value: SECRET })).status, 400);
    assert.equal((await answer(request.id, { value: SECRET, hosts: ['github.com'] })).status, 400);

    // The outcome starts a run; its first command sees the placeholder, and the proxy swaps it.
    script.push([rig.bash('echo "K=$STRIPE_KEY"')], []);
    const provided = await answer(request.id, { value: SECRET, hosts: [HOST] });
    assert.equal(provided.status, 200, await provided.clone().text());
    assert.equal(SecretRequest.parse(await provided.json()).state, 'provided');
    await rig.until(
      async () => rig.bodies.length,
      (count) => count >= 4,
    );
    const done = await rig.settled(session.id);
    assert.equal(done.secretRequests[0]?.state, 'provided');
    assert.match(rig.bodies[2] ?? '', /stored the network secret STRIPE_KEY for api\.fakeprovider\.test/);

    const placeholder = /K=(cloudswe_ph_STRIPE_KEY_[0-9a-f]{32})/.exec(
      toolResults(rig.bodies[3] ?? '').at(-1)?.output ?? '',
    )?.[1];

    assert.ok(placeholder, 'the command got the placeholder');

    // A repeat changes nothing.
    const repeat = await answer(request.id, { decline: true });
    assert.equal(SecretRequest.parse(await repeat.json()).state, 'provided');

    const reply = await new Promise<string>((resolve, reject) => {
      const call = httpRequest(
        new URL(`/net/${session.id}/${HOST}/echo`, rig.base()),
        {
          headers: {
            'x-cloud-swe-network-token': token() ?? '',
            'x-cloud-swe-nonce': '0'.repeat(32),
            Authorization: `Bearer ${placeholder}`,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks).subarray(0, -17).toString()));
        },
      );

      call.on('error', reject);
      call.end();
    });

    assert.equal(reply, 'real-key');

    // The value is in no client view and no Thread or Pi record.
    const views = [
      JSON.stringify(await rig.session(session.id)),
      JSON.stringify(await rig.snapshot(session.id)),
      JSON.stringify(await rig.history(session.id)),
      ...rig.bodies,
    ];

    for (const view of views) assert.equal(view.includes(SECRET), false);
    const database = await rig.storageFor(session.id);

    // Miniflare refuses reads of the KV table; the stored request is a strict SecretRequest, which has no value field.
    for (const table of ['pi_entries', 'pi_tasks', 'pi_submissions', 'pi_documents']) {
      const rows = (await database.exec(`SELECT * FROM ${table}`)).map((row) =>
        Object.values(row).map((value) =>
          value instanceof ArrayBuffer ? Buffer.from(value).toString('latin1') : String(value),
        ),
      );

      assert.equal(JSON.stringify(rows).includes(SECRET), false, table);
    }

    // A decline is delivered too.
    script.push([ask('OTHER_KEY')], []);
    await rig.accepted(await rig.send(session.id, 'Another one'));
    const second = (await rig.settled(session.id)).secretRequests.find(({ name }) => name === 'OTHER_KEY');
    assert.ok(second);
    const before = rig.bodies.length;
    assert.equal((await answer(second.id, { decline: true })).status, 200);
    await rig.until(
      async () => rig.bodies.length,
      (count) => count > before,
    );
    assert.match(rig.bodies.at(-1) ?? '', /declined to provide the network secret OTHER_KEY/);
  } finally {
    await rig.close();
  }
});

test('a session without an environment cannot request a secret', { timeout: 60_000 }, async () => {
  const { rig, script } = await secretRig();

  try {
    const session = await rig.create();
    script.push([ask('KEY')], []);
    await rig.accepted(await rig.send(session.id, 'Use it'));
    const settled = await rig.settled(session.id);
    const result = toolResults(rig.bodies.at(-1) ?? '').at(-1);
    assert.equal(result?.isError, true);
    assert.match(result?.output ?? '', /no environment/);
    assert.deepEqual(settled.secretRequests, []);
  } finally {
    await rig.close();
  }
});

test('cancelling withdraws a queued outcome instead of starting a run for it', { timeout: 120_000 }, async () => {
  const { rig, script } = await secretRig();

  try {
    const session = await rig.create('dev');
    script.push([ask('KEY')], []);
    await rig.accepted(await rig.send(session.id, 'Use it'));
    const [request] = (await rig.settled(session.id)).secretRequests;
    assert.ok(request);

    script.push([rig.bash('sleep 30')]);
    const work = await rig.accepted(await rig.send(session.id, 'Work'));
    await rig.until(async () => rig.requests('POST', /\/commands$/)[0], Boolean);

    const answered = await rig.api(`/v1/sessions/${session.id}/secret-requests/${request.id}`, { decline: true });
    assert.equal(answered.status, 200, await answered.clone().text());

    await rig.until(
      () => rig.session(session.id),
      (current) => current.pending.some(({ status }) => status === 'queued'),
    );

    const cancelled = await rig.api(`/v1/sessions/${session.id}/cancel`, {
      operationId: crypto.randomUUID(),
      runId: work.runId,
    });

    assert.equal(cancelled.status, 202, await cancelled.clone().text());
    assert.deepEqual(CancelRunResponse.parse(await cancelled.json()).restoredMessages, []);
    assert.equal((await rig.settled(session.id)).run.kind, 'cancelled');

    const before = rig.bodies.length;
    await rig.accepted(await rig.send(session.id, 'Carry on'));
    await rig.settled(session.id);
    assert.equal(rig.bodies.length, before + 1, 'the withdrawn outcome started no run of its own');
    assert.match(rig.bodies.at(-1) ?? '', /declined to provide the network secret KEY[\s\S]*Carry on/);
  } finally {
    await rig.close();
  }
});
