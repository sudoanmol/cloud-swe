// Feasibility spike for transparent network secrets on a real E2B sandbox, through the deployed spike Worker.
// Billed (cents). Run from server/: node --env-file=<.env with E2B_API_KEY> ../experiments/network-secrets/run.mjs
// Needs SPIKE_WORKER_URL, SPIKE_TOKEN, PH (placeholder) and DUMMY (the Worker's DUMMY_SECRET) in the environment.

import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const { Sandbox } = await import(createRequire(resolve('package.json')).resolve('e2b'));
const { E2B_API_KEY: apiKey, SPIKE_WORKER_URL: workerUrl, SPIKE_TOKEN: token, PH, DUMMY } = process.env;
const here = import.meta.dirname;
const log = join(here, 'results.log');
writeFileSync(log, `# run ${new Date().toISOString()}\n`);
const line = (text) => {
  console.log(text);
  appendFileSync(log, text.replaceAll(token, '<token>') + '\n');
};

const hosts = JSON.parse(readFileSync(join(here, 'hosts.json'), 'utf8'));
const allHosts = [...hosts.echo, ...Object.keys(hosts.providers)];
const sandbox = await Sandbox.create('cloud-swe', { apiKey, timeoutMs: 45 * 60 * 1000, metadata: { purpose: 'net-spike' } });
line(`sandbox ${sandbox.sandboxId}`);

const run = async (label, command, { user = 'user', timeoutMs = 300_000 } = {}) => {
  const started = Date.now();
  const result = await sandbox.commands
    .run(`bash -lc ${JSON.stringify(command)}`, { user, timeoutMs, envs: {} })
    .catch((error) => ({ exitCode: error.exitCode ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }));
  line(`\n## ${label} (exit ${result.exitCode}, ${Date.now() - started} ms)`);
  if (result.stdout.trim()) line(result.stdout.trim().slice(-6000));
  if (result.exitCode !== 0 && result.stderr.trim()) line('stderr: ' + result.stderr.trim().slice(-2000));

  return result;
};

const env = `PH=${PH}`;

try {
  for (const file of ['daemon.mjs', 'setup.sh', 'hosts.json']) await sandbox.files.write(`/tmp/spike/${file}`, readFileSync(join(here, file), 'utf8'));
  for (const file of readdirSync(join(here, 'clients'))) await sandbox.files.write(`/tmp/spike/clients/${file}`, readFileSync(join(here, 'clients', file), 'utf8'));
  await sandbox.files.write('/tmp/spike/egress.json', JSON.stringify({ workerUrl, token, hosts: allHosts }));

  await run('versions', 'uname -r; cat /etc/os-release | head -2; node --version; python3 --version; openssl version; curl --version | head -1');
  await run('setup (root)', 'bash /tmp/spike/setup.sh', { user: 'root' });
  await run('agent cannot read daemon config', 'cat /etc/cloud-swe/egress.json 2>&1 | head -1; ls -ld /etc/cloud-swe; id; sudo -n true 2>&1 && echo "user has passwordless sudo" || echo "no passwordless sudo"');
  await run('env seen by a login shell', 'env | grep -E "NODE_EXTRA|REQUESTS_CA|SSL_CERT|DENO_CERT"; getent hosts api.openai.com; getent hosts registry.npmjs.org');

  // Package managers after setup: proves untouched hosts still work.
  await run('install ruby + go (root, apt)', 'apt-get install -y -qq ruby golang-go >/dev/null 2>&1 && ruby --version && go version', { user: 'root', timeoutMs: 600_000 });
  await run('npm install SDKs', 'cd /tmp/spike/clients && npm init -y >/dev/null && npm i --silent openai @anthropic-ai/sdk stripe twilio && npm ls --depth=0', { timeoutMs: 600_000 });
  await run('pip install SDKs', 'pip install --user --break-system-packages -q requests httpx aiohttp openai anthropic stripe && pip list --user 2>/dev/null | grep -iE "^(requests|httpx|aiohttp|openai|anthropic|stripe) "', { timeoutMs: 600_000 });
  await run('install bun + deno', 'curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; curl -fsSL https://deno.land/install.sh | sh -s -- -y >/dev/null 2>&1; ~/.bun/bin/bun --version; ~/.deno/bin/deno --version | head -1', { timeoutMs: 600_000 });

  const c = 'cd /tmp/spike/clients && ' + env + ' ';
  await run('curl', c + `curl -sS https://httpbin.org/anything -H "Authorization: Bearer $PH" | jq -c "{auth: .headers.Authorization}"; curl -sS -o /dev/null -w "public %{http_code}\\n" https://example.com`);
  await run('wget', c + `wget -qO- --header="Authorization: Bearer $PH" https://httpbin.org/anything | jq -c "{auth: .headers.Authorization}"`);
  await run('node fetch', c + 'node node-fetch.mjs');
  await run('node https', c + 'node node-https.mjs');
  await run('node fetch, NODE_USE_SYSTEM_CA only', c + 'env -u NODE_EXTRA_CA_CERTS NODE_USE_SYSTEM_CA=1 node node-fetch.mjs');
  await run('node fetch, no CA env (control)', c + 'env -u NODE_EXTRA_CA_CERTS node node-fetch.mjs 2>&1 | tail -2');
  await run('node SDKs: openai, anthropic, stripe, twilio', c + 'node node-sdks.mjs');
  for (const lib of ['requests', 'httpx', 'urllib', 'aiohttp']) await run(`python ${lib}`, c + `python3 py-echo.py ${lib}`);
  await run('python requests, no CA env (control)', c + 'env -u REQUESTS_CA_BUNDLE -u SSL_CERT_FILE python3 py-echo.py requests 2>&1 | tail -1');
  await run('python SDKs: openai, anthropic, stripe', c + 'python3 py-sdks.py');
  await run('bun fetch', c + '~/.bun/bin/bun echo-runtime.mjs');
  await run('bun fetch, no CA env (control)', c + 'env -u NODE_EXTRA_CA_CERTS ~/.bun/bin/bun echo-runtime.mjs 2>&1 | tail -1');
  await run('deno fetch', c + '~/.deno/bin/deno run -A echo-runtime.mjs');
  await run('go net/http', c + 'go run echo.go');
  await run('ruby net/http', c + 'ruby echo.rb');
  await run('provider sweep (node fetch at real hosts)', c + 'node sweep.mjs', { timeoutMs: 120_000 });
  await run('transport: streaming, chunked, big upload, abort, basic, redirect', c + 'node transport.mjs', { timeoutMs: 120_000 });

  await run('kill daemon, expect respawn', 'kill $(cat /etc/cloud-swe/daemon.pid); sleep 2; cat /etc/cloud-swe/daemon.pid', { user: 'root' });
  await run('node fetch after respawn', c + 'node node-fetch.mjs');

  line('\n## pause');
  line(`paused: ${await Sandbox.pause(sandbox.sandboxId, { apiKey })}`);
  await sleep(5000);
  await Sandbox.connect(sandbox.sandboxId, { apiKey });
  await run('after resume: daemon still the same process?', 'cat /etc/cloud-swe/daemon.pid; pgrep -f daemon.mjs | head -3', { user: 'root' });
  await run('node fetch after resume', c + 'node node-fetch.mjs');
  await run('daemon log', 'tail -20 /var/log/cloud-swe-egress.log', { user: 'root' });
} finally {
  await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch((error) => line('kill failed: ' + error));
  const left = await Sandbox.list({ apiKey }).nextItems();
  line(`\nsandboxes left on the account: ${left.length} ${left.map((s) => s.sandboxId + ':' + s.state).join(', ')}`);
}
