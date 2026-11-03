// Round 3 of the spike: real keys, long waits, WebSockets, more runtimes and SDKs, Docker, pause mid-stream.
// Same env as run.mjs. Billed (cents).
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const { Sandbox } = await import(createRequire(resolve('package.json')).resolve('e2b'));
const { E2B_API_KEY: apiKey, SPIKE_WORKER_URL: workerUrl, SPIKE_TOKEN: token, PH, DUMMY } = process.env;
const here = import.meta.dirname;
const log = join(here, 'results.log');
const redact = (text) => text.replaceAll(token, '<token>').replaceAll(DUMMY, '<DUMMY>').replaceAll(PH, '<PH>');
const line = (text) => { console.log(redact(text)); appendFileSync(log, redact(text) + '\n'); };
appendFileSync(log, `\n# round 4 (reruns of round 3 checks the harness broke) ${new Date().toISOString()}\n`);
const hosts = JSON.parse(readFileSync(join(here, 'hosts.json'), 'utf8'));
const sandbox = await Sandbox.create('cloud-swe', { apiKey, timeoutMs: 60 * 60 * 1000, metadata: { purpose: 'net-spike' }, network: { allowPublicTraffic: true } });
const slow = sandbox.getHost(8080);
line(`sandbox ${sandbox.sandboxId}, test server ${slow.replace(sandbox.sandboxId, '<id>')}`);
const run = async (label, command, { user = 'user', timeoutMs = 300_000 } = {}) => {
  const started = Date.now();
  const result = await sandbox.commands.run(command, { user, timeoutMs })
    .catch((error) => ({ exitCode: error.exitCode ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }));
  line(`\n## ${label} (exit ${result.exitCode}, ${Date.now() - started} ms)`);
  if (result.stdout.trim()) line(result.stdout.trim().slice(-8000));
  if (result.exitCode !== 0 && result.stderr.trim()) line('stderr: ' + result.stderr.trim().slice(-1500));
  return result;
};
const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const node = (script) => `bash -lc 'set -a; . /tmp/spike/test.env; set +a; cd /tmp/spike/clients && ${script}'`;
const sh = (section) => `bash -lc 'bash /tmp/spike/clients/round3.sh ${section}'`;

try {
  for (const file of ['daemon.mjs', 'setup.sh', 'hosts.json']) await sandbox.files.write(`/tmp/spike/${file}`, readFileSync(join(here, file), 'utf8'));
  for (const file of walk(join(here, 'clients'))) await sandbox.files.write(`/tmp/spike/clients/${relative(join(here, 'clients'), file)}`, readFileSync(file, 'utf8'));
  await sandbox.files.write('/tmp/spike/egress.json', JSON.stringify({ workerUrl, token, hosts: [...hosts.echo, ...Object.keys(hosts.providers), slow] }));
  await sandbox.files.write('/tmp/spike/test.env', `PH=${PH}\nDUMMY=${DUMMY}\nSLOW=${slow}\n`);
  await run('setup (root)', 'bash /tmp/spike/setup.sh', { user: 'root' });
  await sandbox.commands.run('python3 /tmp/spike/clients/testserver.py', { background: true, timeoutMs: 0 });
  await sleep(1000);

  await run('apt: wget, java, php, rust deps (root)', 'apt-get install -y -qq wget default-jre-headless php-cli php-curl libssl-dev pkg-config >/dev/null 2>&1; java -version 2>&1 | head -1', { user: 'root', timeoutMs: 900_000 });
  await run('pip: genai, mistralai, httplib2', `bash -lc 'pip install --user --break-system-packages -q google-genai mistralai httplib2 && pip list --user 2>/dev/null | grep -iE "^(google-genai|mistralai|httplib2) "'`, { timeoutMs: 900_000 });
  await run('rustup + cargo build', `bash -lc 'curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null 2>&1; . ~/.cargo/env; cd /tmp/spike/clients/rustecho && cargo build -q --release 2>&1 | tail -5; ls target/release/rustecho'`, { timeoutMs: 1_200_000 });
  await run('test server reachable directly (control)', `bash -lc 'curl -sS --doh-url https://1.1.1.1/dns-query -o /dev/null -w "%{http_code}" https://${slow}/echo'`);
  await run('curl: swap, http2 fallback, 100-continue, big bodies, throughput, DoH bypass', sh('curl'), { timeoutMs: 600_000 });
  await run('wget', sh('wget'));
  await run('methods, HEAD, cookies, gzip, query key', node('node methods.mjs'));
  await run('100 parallel requests', node('node load.mjs'));
  await run('more python SDKs (placeholder)', node('python3 sdks2.py'), { timeoutMs: 120_000 });
  await run('java HttpClient', sh('java'), { timeoutMs: 120_000 });
  await run('php curl + streams', sh('php'));
  await run('rust reqwest', `bash -lc '. ~/.cargo/env; bash /tmp/spike/clients/round3.sh rust'`, { timeoutMs: 120_000 });
  await run('130 s first byte + 150 s SSE, concurrently', node('node long.mjs'), { timeoutMs: 400_000 });

  // Pause while an SSE stream is open: what does the client see after resume?
  await sandbox.commands.run(node('node long-sse-pause.mjs > /tmp/pause.out 2>&1'), { background: true, timeoutMs: 0 });
  await sleep(8000);
  line(`\n## pause mid-stream: paused=${await Sandbox.pause(sandbox.sandboxId, { apiKey })}`);
  await sleep(20000);
  await Sandbox.connect(sandbox.sandboxId, { apiKey });
  await sleep(40000);
  await run('pause mid-stream: client output', 'cat /tmp/pause.out; pgrep -f daemon.mjs | head -2', { user: 'root' });
  await run('after resume: fresh request', node('node node-fetch.mjs'));
  await run('daemon log', 'tail -15 /var/log/cloud-swe-egress.log', { user: 'root' });
} finally {
  await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch((error) => line('kill failed: ' + error));
  const left = await Sandbox.list({ apiKey }).nextItems();
  line(`\nsandboxes left on the account: ${left.length}`);
}
