// Round 7: where is a mid-stream upstream death hidden? The Worker reads the body itself and reports.
import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const { Sandbox } = await import(createRequire(resolve('package.json')).resolve('e2b'));
const { E2B_API_KEY: apiKey, SPIKE_WORKER_URL: workerUrl, SPIKE_TOKEN: token } = process.env;
const here = import.meta.dirname;
const line = (text) => { console.log(text); appendFileSync(join(here, 'results.log'), text.replaceAll(token, '<token>') + '\n'); };
appendFileSync(join(here, 'results.log'), `\n# round 7 ${new Date().toISOString()}\n`);
const sandbox = await Sandbox.create('cloud-swe', { apiKey, timeoutMs: 15 * 60 * 1000, metadata: { purpose: 'net-spike' }, network: { allowPublicTraffic: true } });
const slow = sandbox.getHost(8080);
try {
  await sandbox.files.write('/tmp/spike/clients/testserver.py', readFileSync(join(here, 'clients', 'testserver.py'), 'utf8'));
  const start = () => sandbox.commands.run('python3 /tmp/spike/clients/testserver.py', { background: true, timeoutMs: 0 });
  await start(); await sleep(1500);
  for (const [label, path] of [['SSE (chunked) killed mid-stream', '/sse?n=60']]) {
    const pending = fetch(`${workerUrl}/diag/${slow}${path}`, { headers: { 'x-spike-token': token } }).then((r) => r.text());
    await sleep(5000);
    await sandbox.commands.run('pkill -f testserver.py', { user: 'root' }).catch(() => {});
    line(`Worker reading upstream itself, ${label}: ${await pending}`);
    await start(); await sleep(1500);
  }
} finally {
  await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch(() => {});
  line(`sandboxes left on the account: ${(await Sandbox.list({ apiKey }).nextItems()).length}`);
}
