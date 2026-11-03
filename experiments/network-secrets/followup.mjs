// Second, shorter spike run: the checks the first run left open. Same env as run.mjs.
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const { Sandbox } = await import(createRequire(resolve('package.json')).resolve('e2b'));
const { E2B_API_KEY: apiKey, SPIKE_WORKER_URL: workerUrl, SPIKE_TOKEN: token, PH } = process.env;
const here = import.meta.dirname;
const log = join(here, 'results.log');
const line = (text) => { console.log(text); appendFileSync(log, text.replaceAll(token, '<token>') + '\n'); };
appendFileSync(log, `\n# follow-up run ${new Date().toISOString()}\n`);
const hosts = JSON.parse(readFileSync(join(here, 'hosts.json'), 'utf8'));
const sandbox = await Sandbox.create('cloud-swe', { apiKey, timeoutMs: 30 * 60 * 1000, metadata: { purpose: 'net-spike' } });
line(`sandbox ${sandbox.sandboxId}`);
const run = async (label, command, { user = 'user', timeoutMs = 300_000 } = {}) => {
  const started = Date.now();
  const result = await sandbox.commands.run(`bash -lc ${JSON.stringify(command)}`, { user, timeoutMs })
    .catch((error) => ({ exitCode: error.exitCode ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }));
  line(`\n## ${label} (exit ${result.exitCode}, ${Date.now() - started} ms)`);
  if (result.stdout.trim()) line(result.stdout.trim().slice(-12000));
  if (result.exitCode !== 0 && result.stderr.trim()) line('stderr: ' + result.stderr.trim().slice(-1500));
};
try {
  for (const file of ['daemon.mjs', 'setup.sh', 'hosts.json']) await sandbox.files.write(`/tmp/spike/${file}`, readFileSync(join(here, file), 'utf8'));
  for (const file of readdirSync(join(here, 'clients'))) await sandbox.files.write(`/tmp/spike/clients/${file}`, readFileSync(join(here, 'clients', file), 'utf8'));
  await sandbox.files.write('/tmp/spike/egress.json', JSON.stringify({ workerUrl, token, hosts: [...hosts.echo, ...Object.keys(hosts.providers)] }));
  await run('setup (root)', 'bash /tmp/spike/setup.sh', { user: 'root' });
  const c = `cd /tmp/spike/clients && export PH=${PH} && `;
  await run('curl', c + `curl -sS https://httpbin.org/anything -H "Authorization: Bearer $PH" | jq -c "{auth: .headers.Authorization}"; curl -sS -o /dev/null -w "public %{http_code}\\n" https://example.com`);
  await run('wget', c + `wget -qO- --header="Authorization: Bearer $PH" https://httpbin.org/anything | jq -c "{auth: .headers.Authorization}"; wget -qO /dev/null https://example.com && echo public ok`);
  await run('python urllib debug', c + 'python3 urllib-debug.py');
  await run('SSE through daemon + worker', c + 'node sse.mjs');
  await run('provider sweep', c + 'node sweep.mjs', { timeoutMs: 120_000 });
  await run('python stripe: default vs ca_bundle_path', c + 'pip install --user --break-system-packages -q stripe && python3 stripe-fix.py', { timeoutMs: 300_000 });
  await run('docker container inside sandbox (expected bypass)', `export PH=${PH}; sudo systemctl start docker >/dev/null 2>&1 || (sudo dockerd >/tmp/dockerd.log 2>&1 &); for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; docker run --rm curlimages/curl:8.11.1 -sS -o /dev/null -w "container -> api.openai.com: %{http_code} (remote ip %{remote_ip})\\n" -H "Authorization: Bearer $PH" https://api.openai.com/v1/models`, { timeoutMs: 300_000 });
} finally {
  await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch((error) => line('kill failed: ' + error));
  const left = await Sandbox.list({ apiKey }).nextItems();
  line(`\nsandboxes left on the account: ${left.length}`);
}
