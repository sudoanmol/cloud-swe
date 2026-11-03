// Streaming timing, chunked upload, a large body, client abort, then a request after the abort.
import https from 'node:https';
const PH = process.env.PH;
const out = {};
let t = Date.now();
const drip = await fetch('https://httpbin.org/drip?duration=4&numbytes=4&delay=0', { headers: { Authorization: 'Bearer ' + PH } });
const reader = drip.body.getReader();
const arrivals = [];
for (;;) { const { done } = await reader.read(); if (done) break; arrivals.push(Date.now() - t); }
out.dripArrivalsMs = arrivals;
t = Date.now();
out.chunked = await new Promise((ok, fail) => {
  const req = https.request('https://httpbin.org/anything', { method: 'POST', headers: { 'content-type': 'text/plain', Authorization: 'Bearer ' + PH } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { const j = JSON.parse(b); ok({ status: res.statusCode, data: j.data, te: j.headers['Transfer-Encoding'] ?? null, ms: Date.now() - t }); });
  });
  req.on('error', fail);
  let n = 0; const timer = setInterval(() => { req.write(`part${n};`); if (++n === 3) { clearInterval(timer); req.end(); } }, 300);
});
const big = 'x'.repeat(4 * 1024 * 1024);
t = Date.now();
const bigReply = await fetch('https://httpbin.org/anything', { method: 'POST', body: big, headers: { 'content-type': 'text/plain' } });
out.bigUpload = { status: bigReply.status, echoedBytes: (await bigReply.json().catch(() => ({ data: '' }))).data?.length ?? null, ms: Date.now() - t };
const abort = new AbortController();
setTimeout(() => abort.abort(), 800);
out.abort = await fetch('https://httpbin.org/drip?duration=5&numbytes=5', { signal: abort.signal }).then((r) => r.text()).then(() => 'completed', (e) => e.name);
out.afterAbort = await fetch('https://httpbin.org/anything', { headers: { Authorization: 'Bearer ' + PH } }).then((r) => r.json()).then((j) => j.headers.Authorization);
out.basic = await fetch('https://httpbin.org/anything', { headers: { Authorization: 'Basic ' + btoa('AC1:' + PH) } }).then((r) => r.json()).then((j) => atob(j.headers.Authorization.slice(6)));
out.redirect = await fetch('https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com&status_code=302').then(async (r) => `${r.status} ${(await r.text()).trim()}`);
console.log(JSON.stringify(out));
