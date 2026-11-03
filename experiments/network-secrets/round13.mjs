// Round 13: pause the sandbox while an SSE stream is open, with the trailer-checked daemon hop.
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const { Sandbox } = await import(createRequire(resolve('package.json')).resolve('e2b'));
const { E2B_API_KEY: apiKey, SPIKE_WORKER_URL: workerUrl, SPIKE_TOKEN: token, PH, DUMMY } = process.env;
const here = import.meta.dirname;
const redact = (t) => t.replaceAll(token, '<token>').replaceAll(DUMMY, '<DUMMY>').replaceAll(PH, '<PH>');
const line = (t) => { console.log(redact(t)); appendFileSync(join(here, 'results.log'), redact(t) + '\n'); };
appendFileSync(join(here, 'results.log'), `\n# round 13 (pause mid-stream, trailer-checked hop) ${new Date().toISOString()}\n`);
const hosts = JSON.parse(readFileSync(join(here, 'hosts.json'), 'utf8'));
const sandbox = await Sandbox.create('cloud-swe', { apiKey, timeoutMs: 15 * 60 * 1000, metadata: { purpose: 'net-spike' }, network: { allowPublicTraffic: true } });
const slow = sandbox.getHost(8080);
try {
  for (const f of ['daemon.mjs', 'setup.sh', 'hosts.json']) await sandbox.files.write(`/tmp/spike/${f}`, readFileSync(join(here, f), 'utf8'));
  for (const f of ['testserver.py', 'long-sse-pause.mjs', 'node-fetch.mjs']) await sandbox.files.write(`/tmp/spike/clients/${f}`, readFileSync(join(here, 'clients', f), 'utf8'));
  await sandbox.files.write('/tmp/spike/egress.json', JSON.stringify({ workerUrl, token, hosts: [...hosts.echo, slow] }));
  await sandbox.files.write('/tmp/spike/test.env', `PH=${PH}\nDUMMY=${DUMMY}\nSLOW=${slow}\n`);
  await sandbox.commands.run('bash /tmp/spike/setup.sh', { user: 'root' });
  await sandbox.commands.run('python3 /tmp/spike/clients/testserver.py', { background: true, timeoutMs: 0 });
  await sleep(1500);
  await sandbox.commands.run(`bash -lc 'set -a; . /tmp/spike/test.env; set +a; node /tmp/spike/clients/long-sse-pause.mjs > /tmp/pause.out 2>&1'`, { background: true, timeoutMs: 0 });
  await sleep(8000);
  line(`paused: ${await Sandbox.pause(sandbox.sandboxId, { apiKey })}`);
  await sleep(20000);
  await Sandbox.connect(sandbox.sandboxId, { apiKey });
  await sleep(60000);
  const out = await sandbox.commands.run('grep -v "^event" /tmp/pause.out; grep -c "^event" /tmp/pause.out; tail -5 /var/log/cloud-swe-egress.log', { user: 'root' });
  line(`client after resume:\n${out.stdout}`);
  const fresh = await sandbox.commands.run(`bash -lc 'set -a; . /tmp/spike/test.env; set +a; node /tmp/spike/clients/node-fetch.mjs'`);
  line(`fresh request after resume: ${fresh.stdout}`);
} finally {
  await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch(() => {});
  await sleep(3000);
  line(`sandboxes left on the account: ${(await Sandbox.list({ apiKey }).nextItems()).length}`);
}
