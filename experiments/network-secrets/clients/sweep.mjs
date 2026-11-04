// Every provider at its real host with the placeholder in its own auth header. Classifies what came back.
import { readFileSync } from 'node:fs';
const { providers } = JSON.parse(readFileSync('/tmp/spike/hosts.json', 'utf8'));
const PH = process.env.PH;
const rows = await Promise.all(Object.entries(providers).map(async ([host, p]) => {
  const value = p.scheme === 'Basic' ? 'Basic ' + btoa('AC00000000000000000000000000000000:' + PH) : (p.scheme ? p.scheme + ' ' : '') + PH;
  const headers = { [p.header]: value, 'content-type': 'application/json', 'user-agent': 'cloud-swe-spike' };
  for (const line of p.extra ?? []) { const [k, ...v] = line.split(':'); headers[k] = v.join(':').trim(); }
  const started = Date.now();
  try {
    const r = await fetch(`https://${host}${p.path}`, { method: p.method ?? 'GET', headers, body: p.method === 'POST' ? (p.body ?? '{}') : undefined, signal: AbortSignal.timeout(20000) });
    const body = (await r.text()).replace(/\s+/g, ' ').slice(0, 180);
    const blocked = r.headers.get('cf-mitigated') || /attention required|cloudflare ray id|error 1020|access denied/i.test(body);
    return { host, status: r.status, ms: Date.now() - started, viaWorkerMs: r.headers.get('x-spike-upstream-ms'), blocked: Boolean(blocked), placeholderEchoed: body.includes(PH), body };
  } catch (e) { return { host, error: String(e.cause?.code ?? e.message) }; }
}));
for (const row of rows) console.log(JSON.stringify(row));
