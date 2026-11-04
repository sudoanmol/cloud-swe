// Drives the whole product over its public API, as a client would: real E2B, real model, real GitHub when deployed.
// Billed. Run from server/: node --env-file=../.env ../experiments/e2b-e2e/run.mjs [--deployed] [--only a,b] [--no-idle]
// Local mode needs `pnpm --filter server build:test` first, and skips Git: a sandbox can't reach a local Worker.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const deployed = args.includes('--deployed');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : undefined;
const { Sandbox } = await import(createRequire(resolve('package.json')).resolve('e2b'));
const apiKey = process.env.E2B_API_KEY;
const template = 'cloud-swe';
const model = { provider: process.env.MODEL_PROVIDER, id: process.env.MODEL_ID };
const log = join(import.meta.dirname, 'results.log');
const line = (text) => {
  console.log(text);
  appendFileSync(log, text + '\n');
};

let base, token, stopLocal;

if (deployed) {
  base = process.env.PUBLIC_URL;
  token = process.env.CLOUD_SWE_TOKEN;
} else {
  const { runtime } = await import(resolve('test/runtime.ts'));
  const storage = mkdtempSync(join(tmpdir(), 'cloud-swe-e2e-'));
  const mf = runtime(storage, {
    WORKSPACE_BACKEND: 'e2b',
    WORKSPACE_TEMPLATES: template,
    MODEL_PROVIDER: model.provider,
    MODEL_ID: model.id,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  });

  base = (await mf.ready).origin;
  token = 'integration-test-personal-token';
  stopLocal = async () => {
    await mf.dispose();
    rmSync(storage, { recursive: true, force: true });
  };
}

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function api(path, init = {}) {
  const response = await fetch(new URL(path, base), { headers, ...init, signal: AbortSignal.timeout(90_000) });
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Sends with one operation ID, retrying the 503s the API tells clients to retry. */
async function post(path, body) {
  for (let attempt = 0; ; attempt++) {
    const result = await api(path, { method: 'POST', body: JSON.stringify(body) });

    if (result.status < 300) return result.body;
    if (result.status !== 503 || attempt === 20) {
      throw new Error(`POST ${path}: ${result.status} ${JSON.stringify(result.body)}`);
    }
    await sleep(3000);
  }
}

// Finished calls are history entries and live ones are in `tools`; the live view wins.
const activity = (snapshot) => {
  const calls = new Map();

  for (const entry of snapshot.history.entries) if (entry.kind === 'tool') calls.set(entry.toolCallId, entry);
  for (const tool of snapshot.tools) calls.set(tool.toolCallId, tool);

  return [...calls.values()];
};

class Conversation {
  seen = new Set();
  sandboxId;

  static async start(extra = {}) {
    const conversation = new Conversation();
    const { session } = await post('/v1/sessions', { operationId: crypto.randomUUID(), template, model, ...extra });

    conversation.id = session.id;
    conversation.session = session;
    line(`session ${session.id}`);
    created.push(conversation);
    assert.equal(session.workspace.provider, 'e2b');
    await until('a sandbox to be listed', 30, async () => {
      const [found] = await Sandbox.list({
        apiKey,
        query: { metadata: { cloudSweWorkspace: session.workspace.id } },
      }).nextItems();

      conversation.sandboxId = found?.sandboxId;

      return found;
    });

    return conversation;
  }

  path = (suffix = '') => `/v1/sessions/${this.id}${suffix}`;

  async snapshot() {
    const { status, body } = await api(this.path('/snapshot'));

    assert.equal(status, 200, JSON.stringify(body));

    return body;
  }

  send(text, mode = 'reject') {
    return post(this.path('/messages'), { operationId: crypto.randomUUID(), text, mode });
  }

  /** Waits for the given run, or for whichever is current, to end with nothing queued. */
  async settled(minutes = 8, runId) {
    return until('the run to settle', minutes * 30, async () => {
      const snapshot = await this.snapshot();
      const { run, pending } = snapshot.session;
      const ended = !['idle', 'running', 'cancelling', 'retrying'].includes(run.kind);

      return ended && pending.length === 0 && (!runId || run.runId === runId) && snapshot;
    }, 2000);
  }

  /** Tool calls since the last call to this, in order. */
  fresh(snapshot) {
    const tools = activity(snapshot).filter((tool) => !this.seen.has(tool.toolCallId));

    for (const tool of tools) this.seen.add(tool.toolCallId);

    return tools;
  }

  /** One message to completion; returns its tool calls and final text. */
  async ask(text, minutes) {
    const { runId } = await this.send(text);
    const snapshot = await this.settled(minutes, runId);

    assert.equal(snapshot.session.run.kind, 'completed', JSON.stringify(snapshot.session.run));

    return { snapshot, tools: this.fresh(snapshot), text: lastText(snapshot) };
  }

  async bash(command, minutes) {
    const answer = await this.ask(
      `Call the bash tool exactly once with exactly this command, unchanged, then reply "done":\n\n${command}`,
      minutes,
    );
    const call = answer.tools.filter((tool) => tool.name === 'bash').at(-1);

    assert.ok(call, `no bash call; tools: ${answer.tools.map((tool) => tool.name)}; text: ${answer.text}`);
    assert.equal(call.outcome.kind, 'succeeded', JSON.stringify(call.outcome).slice(0, 1500));

    return call.outcome.output ?? '';
  }

  /** Waits until a bash call whose command includes `marker` is running in the sandbox. */
  runningBash(marker) {
    return until(`bash "${marker}" to run`, 90, async () => {
      return activity(await this.snapshot()).find(
        (tool) => tool.name === 'bash' && tool.outcome.kind === 'running' && JSON.stringify(tool.arguments).includes(marker),
      );
    }, 1000);
  }
}

async function until(what, attempts, check, delay = 1000) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check();

    if (value) return value;
    await sleep(delay);
  }

  throw new Error(`Timed out waiting for ${what}`);
}

const lastText = (snapshot) =>
  snapshot.history.entries
    .filter((entry) => entry.kind === 'message' && entry.role === 'assistant')
    .at(-1)
    ?.content.filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('') ?? '';

const allText = (snapshot) =>
  snapshot.history.entries
    .filter((entry) => entry.kind === 'message' && entry.role === 'assistant')
    .flatMap((entry) => entry.content.filter((block) => block.kind === 'text').map((block) => block.text))
    .join('\n');

const gh = (...command) => execFileSync('gh', command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const created = [];
const results = [];

async function stage(name, run) {
  if (only && !only.includes(name)) return;
  const started = Date.now();

  try {
    const note = await run();

    results.push([name, true]);
    line(`PASS ${name} (${Math.round((Date.now() - started) / 1000)}s)${note ? ': ' + note : ''}`);
  } catch (error) {
    results.push([name, false]);
    line(`FAIL ${name} (${Math.round((Date.now() - started) / 1000)}s): ${String(error.message).slice(0, 1800)}`);
  }
}

line(`\n=== ${new Date().toISOString()} ${deployed ? 'deployed' : 'local Worker'} ${model.id}`);

const main = await Conversation.start();

await stage('sessions', async () => {
  const operationId = crypto.randomUUID();
  const first = await post('/v1/sessions', { operationId, template, model });
  const retry = await post('/v1/sessions', { operationId, template, model });

  created.push(Object.assign(new Conversation(), { id: first.session.id, session: first.session }));
  assert.equal(retry.session.id, first.session.id, 'a retried create is the same session');
  const list = await api('/v1/sessions');

  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(list.body.sessions.some((session) => session.id === main.id));
  assert.equal((await api(main.path())).body.workspace.state, 'running');
  const refused = await api('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), template: 'nope', model }),
  });

  assert.equal(refused.status, 400, JSON.stringify(refused.body));

  return `${list.body.sessions.length} listed, ${list.body.unavailable.length} unavailable`;
});

await stage('files', async () => {
  const { tools } = await main.ask(
    'Do these one at a time: use the write tool to create notes/a.txt containing "hello"; use the read tool on it; ' +
      'use the edit tool to change hello to "hello e2b"; then use bash to cat it. Then reply "done".',
  );
  const names = tools.map((tool) => tool.name);

  for (const name of ['write', 'read', 'edit', 'bash']) assert.ok(names.includes(name), `no ${name} in ${names}`);
  for (const tool of tools) assert.equal(tool.outcome.kind, 'succeeded', JSON.stringify(tool.outcome).slice(0, 800));
  assert.match(tools.find((tool) => tool.name === 'bash').outcome.output, /hello e2b/);
});

await stage('sse', async () => {
  const controller = new AbortController();
  const frames = [];

  const reader = (async () => {
    const response = await fetch(new URL(main.path('/events'), base), { headers, signal: controller.signal });

    assert.equal(response.status, 200);
    let buffer = '';

    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let end;

      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const data = buffer.slice(0, end).split('\n').find((part) => part.startsWith('data:'));

        buffer = buffer.slice(end + 2);
        if (data) frames.push(JSON.parse(data.slice(5)));
      }
    }
  })().catch((error) => {
    if (error.name !== 'AbortError') throw error;
  });

  let output;

  try {
    output = await main.bash('for i in 1 2 3 4; do echo tick-$i; sleep 2; done');
    await until('the final frame', 20, () => frames.at(-1)?.snapshot.session.run.kind === 'completed');
  } finally {
    controller.abort();
    await reader;
  }

  assert.match(output, /tick-4/);
  const live = frames.flatMap((frame) => frame.snapshot.tools).filter((tool) => tool.outcome.kind === 'running');

  assert.ok(live.some((tool) => tool.name === 'bash'), 'the stream showed the command running');
  assert.ok(live.some((tool) => /tick-\d/.test(tool.outcome.output ?? '')), 'the stream showed its live output');

  return `${frames.length} frames`;
});

await stage('parallel', async () => {
  const { tools } = await main.ask(
    'In one single response, make three bash tool calls in parallel, one for each of a, b and c, each exactly: ' +
      'echo start $(date +%s.%N); sleep 6; echo end $(date +%s.%N)\nThen reply "done".',
  );
  const calls = tools.filter((tool) => tool.name === 'bash');

  assert.equal(calls.length, 3, tools.map((tool) => tool.name).join());
  const times = calls.map((call) => {
    assert.equal(call.outcome.kind, 'succeeded');

    return [/start (\S+)/, /end (\S+)/].map((pattern) => Number(pattern.exec(call.outcome.output)[1]));
  });

  assert.ok(Math.max(...times.map(([start]) => start)) < Math.min(...times.map(([, end]) => end)), 'they overlapped');
});

await stage('codemode', async () => {
  const name = main.session.capabilities.tools.find((tool) => /code/i.test(tool));

  assert.ok(name, `no codemode tool in ${main.session.capabilities.tools}`);
  const { tools } = await main.ask(
    `Use the ${name} tool once. In its script, first await one bash call running "echo seq-1", then await two bash ` +
      'calls in parallel running "echo par-a" and "echo par-b", and return all three outputs. Then reply "done".',
  );
  const parent = tools.find((tool) => tool.name === name);

  assert.ok(parent, tools.map((tool) => tool.name).join());
  assert.equal(parent.outcome.kind, 'succeeded', JSON.stringify(parent.outcome).slice(0, 1200));
  assert.ok(parent.nestedCalls.length >= 3, JSON.stringify(parent.nestedCalls).slice(0, 800));
  assert.ok(parent.nestedCalls.every((call) => call.status === 'succeeded'));

  for (const expected of ['seq-1', 'par-a', 'par-b']) assert.ok(parent.outcome.output.includes(expected), expected);

  return `tool ${name}, ${parent.nestedCalls.length} nested calls`;
});

await stage('template', async () => {
  const output = await main.bash(
    [
      'echo "user=$(id -un)"',
      'echo "node=$(node --version) pnpm=$(pnpm --version) git=$(git --version | cut -d" " -f3)"',
      'sudo service postgresql start >/dev/null; sleep 3; echo "pg=$(pg_isready)"',
      'sudo service redis-server start >/dev/null; sleep 1; echo "redis=$(redis-cli ping)"',
      'sudo service docker start >/dev/null; sleep 8; echo "docker=$(sudo docker run --rm hello-world 2>&1 | grep -c "Hello from Docker")"',
      'echo "chromium=$($(ls -d /opt/playwright/chromium-*/chrome-linux*/chrome) --headless --no-sandbox --dump-dom "data:text/html,<h1>rendered</h1>" 2>/dev/null | grep -c rendered)"',
      'echo "cpus=$(nproc) memGB=$(free -g | awk "/Mem:/{print \\$2}")"',
    ].join('\n'),
    5,
  );

  assert.match(output, /user=user/);
  assert.match(output, /node=v24/);
  assert.match(output, /pg=.*accepting connections/);
  assert.match(output, /redis=PONG/);
  assert.match(output, /docker=1/);
  assert.match(output, /chromium=1/);
  assert.match(output, /cpus=4/);

  return output.replace(/\s*\n\s*/g, ' | ').slice(0, 300);
});

// Run by the driver, not the model: Anthropic's policy check blocks a prompt that looks for credentials.
const scanForCredentials = async (sandboxId) => {
  const sandbox = await Sandbox.connect(sandboxId, { apiKey });
  const names = await sandbox.commands.run('env | cut -d= -f1');
  const files = await sandbox.commands.run(
    'grep -rlE "ghs_|ghp_|gho_|sk-ant-|e2b_[0-9a-f]{20}" /home/user /tmp /etc/environment --exclude-dir=node_modules 2>/dev/null | head -5; true',
  );

  assert.doesNotMatch(names.stdout, /ANTHROPIC|GITHUB_|E2B_API_KEY|FIRECRAWL|BETTER_AUTH|BOAT_API/);
  assert.equal(files.stdout.trim(), '', 'a file holds a credential');
};

await stage('no-secrets-in-sandbox', () => scanForCredentials(main.sandboxId));

await stage('web-tools', async () => {
  const { tools } = await main.ask(
    'Use the web_search tool once for "E2B sandbox documentation", then the web_fetch tool once on https://example.com. Then reply "done".',
  );

  for (const name of ['web_search', 'web_fetch']) {
    const call = tools.find((tool) => tool.name === name);

    assert.ok(call, `no ${name}: ${tools.map((tool) => tool.name)}`);
    assert.equal(call.outcome.kind, 'succeeded', JSON.stringify(call.outcome).slice(0, 800));
  }
});

await stage('cancel', async () => {
  const receipt = await main.send('Call bash once with exactly: sleep 901; echo never-printed');

  await main.runningBash('sleep 901');
  await sleep(3000);
  await post(main.path('/cancel'), { operationId: crypto.randomUUID(), runId: receipt.runId });
  const snapshot = await until('the cancellation', 45, async () => {
    const current = await main.snapshot();

    return current.session.run.kind === 'cancelled' && current;
  }, 2000);
  const call = activity(snapshot).find((tool) => JSON.stringify(tool.arguments ?? {}).includes('sleep 901'));

  assert.equal(call.outcome.kind, 'interrupted', JSON.stringify(call.outcome));
  main.fresh(snapshot);
  const output = await main.bash("pgrep -af '[s]leep 901' || echo no-such-process");

  assert.match(output, /no-such-process/);
});

await stage('steer-and-follow-up', async () => {
  await main.send('Call bash once with exactly: sleep 25; echo long-done\nThen reply "first finished".');
  await main.runningBash('sleep 25');
  const { session: before } = await main.snapshot();
  assert.equal(before.run.kind, 'running');
  await main.send('Also include the word STEERED-OK in your next reply.', 'steer');
  await main.send('Now reply with the word FOLLOWED-OK.', 'followUp');
  const { session } = await main.snapshot();

  assert.deepEqual(session.pending.map((input) => input.mode).filter((mode) => mode !== 'reject').sort(), ['followUp', 'steer']);
  const snapshot = await main.settled();

  main.fresh(snapshot);
  assert.equal(snapshot.session.run.kind, 'completed', JSON.stringify(snapshot.session.run));
  const text = allText(snapshot);

  assert.match(text, /STEERED-OK/);
  assert.match(text, /FOLLOWED-OK/);
});

await stage('receipts', async () => {
  const operationId = crypto.randomUUID();
  const body = { operationId, text: 'Reply with the word RECEIPT-OK.', mode: 'reject' };
  const first = await post(main.path('/messages'), body);
  const retry = await post(main.path('/messages'), body);

  assert.equal(retry.runId, first.runId, 'a retried message is the same run');
  const { status, body: looked } = await api(main.path(`/operations/${operationId}`));

  assert.equal(status, 200);
  assert.equal(looked.runId, first.runId);
  main.fresh(await main.settled());
});

await stage('pause-mid-command', async () => {
  await main.send('Call bash once with exactly: nohup sleep 7200 >/dev/null 2>&1 & echo $! > keeper.pid; sleep 30; echo pause-survived\nThen reply "done".');
  await main.runningBash('pause-survived');
  await sleep(4000);
  assert.equal(await Sandbox.pause(main.sandboxId, { apiKey }), true);
  const pausedAt = Date.now();

  // No message helps here: an active run's keep-alive has to wake the sandbox by itself.
  const snapshot = await main.settled();
  const call = main.fresh(snapshot).find((tool) => JSON.stringify(tool.arguments ?? {}).includes('pause-survived'));

  assert.equal(snapshot.session.run.kind, 'completed', JSON.stringify(snapshot.session.run));
  assert.equal(call.outcome.kind, 'succeeded', JSON.stringify(call.outcome).slice(0, 800));
  assert.match(call.outcome.output, /pause-survived/);

  return `finished ${Math.round((Date.now() - pausedAt) / 1000)}s after the pause`;
});

await stage('pause-idle-then-message', async () => {
  assert.equal(await Sandbox.pause(main.sandboxId, { apiKey }), true);
  const output = await main.bash('cat notes/a.txt; kill -0 "$(cat keeper.pid)" && echo keeper-alive');

  assert.match(output, /hello e2b/);
  assert.match(output, /keeper-alive/, 'the process left running came back with the sandbox');
  assert.equal((await main.snapshot()).session.workspace.state, 'running');
});

await stage('compaction', async () => {
  await main.ask('Remember this code word for later: ZEBRA-42. Reply "ok".');
  const { status, body } = await api(main.path('/compact'), { method: 'POST', body: '{}' });

  assert.ok(status < 300, `${status} ${JSON.stringify(body)}`);
  const snapshot = await until('the compaction', 90, async () => {
    const current = await main.snapshot();

    return current.session.compaction === null && !['running'].includes(current.session.run.kind) && current;
  }, 2000);

  assert.equal(snapshot.session.compactionFailure, null, JSON.stringify(snapshot.session.compactionFailure));
  const { text } = await main.ask('What was the code word? Do not use any tools.');

  assert.match(text, /ZEBRA-42/);
});

await stage('question-and-todos', async () => {
  const { runId } = await main.send(
    'Use the todo tool to create one task with subject "Write the e2e answer" and activeForm "Writing the e2e answer". ' +
      'Then call ask_user_question once with the question "Which colour should I write?", header "Colour", and options ' +
      '"Teal" and "Amber" (each with a short description), and end your turn.',
  );
  const open = await until('the question', 90, async () => {
    const { session } = await main.snapshot();

    return session.questions?.find((question) => question.state === 'pending');
  }, 2000);

  assert.ok((await main.snapshot()).session.todos.some((todo) => todo.subject === 'Write the e2e answer'));
  await main.settled(8, runId);
  await post(main.path(`/questions/${open.id}`), {
    answers: [{ questionIndex: 0, optionIndexes: [open.questions[0].options.findIndex((option) => option.label === 'Teal')] }],
  });
  const snapshot = await until('the agent to read the answer', 90, async () => {
    const current = await main.snapshot();
    const { run, pending } = current.session;

    return run.runId !== runId && !['running', 'cancelling', 'retrying'].includes(run.kind) && !pending.length && current;
  }, 2000);

  main.fresh(snapshot);
  assert.equal(snapshot.session.run.kind, 'completed', JSON.stringify(snapshot.session.run));
  assert.match(lastText(snapshot), /teal/i);
  const closed = snapshot.session.questions.find((question) => question.id === open.id);

  assert.notEqual(closed.state, 'pending');
});

await stage('credentials-api', async () => {
  const { status, body } = await api('/v1/credentials/models/anthropic');

  assert.equal(status, 200, JSON.stringify(body));
  assert.doesNotMatch(JSON.stringify(body), /sk-ant-/, 'a stored key is never returned');
});

// The sandbox must reach the Worker's /net route, so only through a deployed Worker. A dummy key: httpbin echoes it back.
if (deployed) {
  await stage('network-secrets', async () => {
    const dummy = `sk-test-cloudswe-dummy-${crypto.randomUUID().slice(0, 8)}wxyz`;
    const put = (path, body) => api(`/v1/environments/e2e-net${path}`, { method: 'PUT', body: JSON.stringify(body) });

    await put('', {});
    await put('/variables/E2E_VAR', { value: 'visible-variable' });
    await put('/network-secrets/HTTPBIN_KEY', { value: dummy, hosts: ['httpbin.org'] });
    await put('/network-secrets/OPENAI_API_KEY', { value: dummy, hosts: ['api.openai.com'] });

    try {
      const net = await Conversation.start({ environment: 'e2e-net' });
      const probe = (label, command) => `echo "${label}=$(${command})"`;
      const output = await net.bash(
        [
          'echo "VAR=$E2E_VAR"',
          'echo "PLACEHOLDER=$HTTPBIN_KEY"',
          probe('CURL', 'curl -sS https://httpbin.org/headers -H "Authorization: Bearer $HTTPBIN_KEY" | grep -c ' + dummy),
          probe('NODE', `node -e "fetch('https://httpbin.org/headers',{headers:{authorization:'Bearer '+process.env.HTTPBIN_KEY}}).then(r=>r.text()).then(t=>console.log(t.includes('${dummy}')))"`),
          probe('PYTHON', `python3 -m pip install -q --target /tmp/pylib requests >/dev/null 2>&1; PYTHONPATH=/tmp/pylib python3 -c "import os,requests; print('${dummy}' in requests.get('https://httpbin.org/headers', headers={'Authorization': 'Bearer ' + os.environ['HTTPBIN_KEY']}).text)"`),
          probe('OPENAI', `cd /tmp && npm i --silent --no-audit --no-fund openai >/dev/null 2>&1 && node -e "const { OpenAI } = require('/tmp/node_modules/openai'); new OpenAI().models.list().then(() => console.log('no-error'), (e) => console.log(e.status, String(e.message).includes('wxyz')))"`),
          probe('STREAM', 'curl -sSN "https://httpbin.org/drip?duration=2&numbytes=4" -H "Authorization: Bearer $HTTPBIN_KEY" | wc -c'),
          probe('UNLISTED', `sudo node -e "const c = require('/etc/cloud-swe/egress.json'); fetch(c.workerUrl + '/net/' + c.sessionId + '/example.com/', { headers: { 'x-cloud-swe-network-token': c.token, 'x-cloud-swe-nonce': '0'.repeat(32) } }).then((r) => console.log(r.status))"`),
          probe('LEAKS', `grep -rl ${dummy} ~ /tmp /etc 2>/dev/null | wc -l; env | grep -c ${dummy}`),
        ].join('\n'),
        10,
      );

      assert.match(output, /VAR=visible-variable/);
      assert.match(output, /PLACEHOLDER=cloudswe_ph_HTTPBIN_KEY_[0-9a-f]{32}/);
      assert.match(output, /CURL=1/, 'curl swapped');
      assert.match(output, /NODE=true/, 'Node fetch swapped');
      assert.match(output, /PYTHON=True/, 'Python requests swapped');
      assert.match(output, /OPENAI=401 true/, "the provider's 401 masks the swapped dummy");
      assert.match(output, /STREAM=4/);
      assert.match(output, /UNLISTED=403/);
      assert.match(output, /LEAKS=0\s+0/, 'the dummy is in no sandbox file or env var');

      return 'curl, Node fetch, Python requests and the openai SDK swapped; streaming; 403 off the list';
    } finally {
      await api('/v1/environments/e2e-net', { method: 'DELETE' });
    }
  });
}

if (deployed) await import('./git-stages.mjs').then(({ gitStages }) => gitStages({ Conversation, stage, gh, post, until, sleep, scanForCredentials }));

if (!args.includes('--no-idle')) {
  await stage('idle-auto-pause', async () => {
    // Ten minutes after a finished run, E2B pauses the sandbox, and the next message brings it back.
    const started = Date.now();

    await main.bash('mkdir -p notes; echo hello e2b > notes/a.txt');
    await until('E2B to pause the sandbox', 800, async () => (await Sandbox.getInfo(main.sandboxId, { apiKey })).state === 'paused', 1000);
    const minutes = (Date.now() - started) / 60000;

    assert.ok(minutes > 8 && minutes < 13, `paused after ${minutes} minutes`);
    const state = await until('the session to show it', 60, async () => {
      const current = (await main.snapshot()).session.workspace.state;

      return current === 'stopped' && current;
    }, 2000);
    const output = await main.bash('cat notes/a.txt');

    assert.match(output, /hello e2b/);

    return `paused after ${minutes.toFixed(1)} minutes, session showed ${state}`;
  });
}

if (args.includes('--long')) {
  await stage('command-past-the-hour', async () => {
    // Past E2B's hour limit: the sandbox pauses under the command, and keep-alive has to bring it back.
    const long = await Conversation.start();
    const started = Date.now();
    const output = await long.bash('echo ran >> count.txt; sleep 4200; echo long-finished; wc -l < count.txt', 100);

    assert.match(output, /long-finished/);
    assert.match(output, /^\s*1\s*$/m, 'it ran exactly once');

    return `${((Date.now() - started) / 60000).toFixed(1)} minutes`;
  });
}

for (const conversation of created) {
  const [found] = await Sandbox.list({
    apiKey,
    query: { metadata: { cloudSweWorkspace: conversation.session.workspace.id } },
  }).nextItems();

  if (found) await Sandbox.kill(found.sandboxId, { apiKey });
}

await stopLocal?.();

const failed = results.filter(([, passed]) => !passed).map(([name]) => name);

line(`=== ${results.length - failed.length}/${results.length} passed${failed.length ? '; failed: ' + failed.join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
