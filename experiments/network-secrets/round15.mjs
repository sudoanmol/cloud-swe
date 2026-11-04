// Round 15: latency the proxy adds per request, and the first-request cost (leaf certificate minting).
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const { Sandbox } = await import(createRequire(resolve('package.json')).resolve('e2b'));
const { E2B_API_KEY: apiKey, SPIKE_WORKER_URL: workerUrl, SPIKE_TOKEN: token, PH, DUMMY } = process.env;
const here = import.meta.dirname;
const line = (t) => { console.log(t); appendFileSync(join(here, 'results.log'), t + '\n'); };
appendFileSync(join(here, 'results.log'), `\n# round 15 (latency) ${new Date().toISOString()}\n`);
const hosts = JSON.parse(readFileSync(join(here, 'hosts.json'), 'utf8'));
const sandbox = await Sandbox.create('cloud-swe', { apiKey, timeoutMs: 15 * 60 * 1000, metadata: { purpose: 'net-spike' } });
try {
  for (const f of ['daemon.mjs', 'setup.sh', 'hosts.json']) await sandbox.files.write(`/tmp/spike/${f}`, readFileSync(join(here, f), 'utf8'));
  await sandbox.files.write('/tmp/spike/clients/latency.sh', readFileSync(join(here, 'clients', 'latency.sh'), 'utf8'));
  await sandbox.files.write('/tmp/spike/egress.json', JSON.stringify({ workerUrl, token, hosts: [...hosts.echo, ...Object.keys(hosts.providers)] }));
  await sandbox.files.write('/tmp/spike/test.env', `PH=${PH}\n`);
  await sandbox.commands.run('bash /tmp/spike/setup.sh', { user: 'root' });
  line((await sandbox.commands.run(`bash -lc 'bash /tmp/spike/clients/latency.sh'`, { timeoutMs: 300_000 })).stdout);
} finally {
  await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  line(`sandboxes left on the account: ${(await Sandbox.list({ apiKey }).nextItems()).length}`);
}
