// Round 6: after the fixes, does a killed upstream surface as an error through the Worker and the daemon?
import { appendFileSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);
const { Sandbox } = await import(createRequire(resolve('package.json')).resolve('e2b'));
const { E2B_API_KEY: apiKey, SPIKE_WORKER_URL: workerUrl, SPIKE_TOKEN: token, PH, DUMMY } = process.env;
const here = import.meta.dirname;
const redact = (text) => text.replaceAll(token, '<token>').replaceAll(DUMMY, '<DUMMY>').replaceAll(PH, '<PH>');
const line = (text) => { console.log(redact(text)); appendFileSync(join(here, 'results.log'), redact(text) + '\n'); };
appendFileSync(join(here, 'results.log'), `\n# round 9 (nonce trailer on the daemon hop) ${new Date().toISOString()}\n`);
const hosts = JSON.parse(readFileSync(join(here, 'hosts.json'), 'utf8'));
const sandbox = await Sandbox.create('cloud-swe', { apiKey, timeoutMs: 30 * 60 * 1000, metadata: { purpose: 'net-spike' }, network: { allowPublicTraffic: true } });
const slow = sandbox.getHost(8080);
const curl = async (label, args) => {
  const t = Date.now();
  const r = await exec('curl', ['-sS', '-N', '-o', '/dev/null', '-w', '%{http_code} %{size_download}B', ...args], { timeout: 400_000 }).then((o) => `exit 0 ${o.stdout}`, (e) => `exit ${e.code} ${e.stdout} ${String(e.stderr).trim().slice(0, 120)}`);
  line(`${label}: ${r} after ${Date.now() - t} ms`);
};
const startServer = () => sandbox.commands.run('python3 /tmp/spike/clients/testserver.py', { background: true, timeoutMs: 0 });
try {
  for (const file of ['daemon.mjs', 'setup.sh', 'hosts.json']) await sandbox.files.write(`/tmp/spike/${file}`, readFileSync(join(here, file), 'utf8'));
  for (const file of ['testserver.py', 'truncate.mjs', 'sse.mjs', 'node-fetch.mjs', 'methods.mjs']) await sandbox.files.write(`/tmp/spike/clients/${file}`, readFileSync(join(here, 'clients', file), 'utf8'));
  await sandbox.files.write('/tmp/spike/egress.json', JSON.stringify({ workerUrl, token, hosts: [...hosts.echo, 'stream.wikimedia.org', 'generativelanguage.googleapis.com', slow] }));
  await sandbox.files.write('/tmp/spike/test.env', `PH=${PH}\nDUMMY=${DUMMY}\nSLOW=${slow}\n`);
  await sandbox.commands.run('bash /tmp/spike/setup.sh', { user: 'root' });
  await startServer();
  await sleep(1500);

  const via = (path) => [`${workerUrl}/net/${slow}${path}`, '-H', `x-spike-token: ${token}`];
  line('\n## truncation: upstream killed mid-stream');
  const killAfter = async (ms) => { await sleep(ms); await sandbox.commands.run('pkill -f testserver.py', { user: 'root' }).catch(() => {}); };
  await Promise.all([curl('Mac direct to E2B, SSE then kill', [`https://${slow}/sse?n=60`]), killAfter(5000)]);
  await startServer(); await sleep(1500);
  await Promise.all([curl('Mac via Worker, SSE then kill', via('/sse?n=60')), killAfter(5000)]);
  await startServer(); await sleep(1500);
  const inVm = sandbox.commands.run(`bash -lc 'set -a; . /tmp/spike/test.env; set +a; node /tmp/spike/clients/truncate.mjs'`, { timeoutMs: 120_000 });
  await killAfter(5000);
  line(`in sandbox via daemon + Worker, SSE then kill: ${(await inVm).stdout.trim()}`);
  await startServer(); await sleep(1500);
  const ok = await sandbox.commands.run(`bash -lc 'set -a; . /tmp/spike/test.env; set +a; cd /tmp/spike/clients; node sse.mjs; node node-fetch.mjs; node methods.mjs; curl -sS -X POST --data-binary @/etc/services https://$SLOW/echo | jq -c "{bodyBytes}"; curl -sS -o /dev/null -w "100MB %{http_code} %{size_download}B %{speed_download}B/s\n" https://nbg1-speed.hetzner.com/100MB.bin'`, { timeoutMs: 180_000 }).catch((e) => e);
  line(`framed hop, normal traffic still works:\n${ok.stdout}${ok.stderr ?? ''}`);
} finally {
  await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch((error) => line('kill failed: ' + error));
  line(`\nsandboxes left on the account: ${(await Sandbox.list({ apiKey }).nextItems()).length}`);
}
