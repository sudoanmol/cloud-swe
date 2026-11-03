// A reply that takes 130 s to start, and a 150 s SSE stream, at the same time.
const { PH, SLOW } = process.env; const t = Date.now();
const slow = fetch(`https://${SLOW}/slow?s=130`, { headers: { Authorization: 'Bearer ' + PH } })
  .then(async (r) => `${r.status} ${(await r.text()).slice(0, 60)} after ${Date.now() - t} ms`, (e) => `error ${e.cause?.code ?? e.message} after ${Date.now() - t} ms`);
const sse = (async () => {
  const r = await fetch(`https://${SLOW}/sse?n=150`, { headers: { Authorization: 'Bearer ' + PH } });
  const reader = r.body.getReader(); const dec = new TextDecoder(); let events = 0, buf = '', first, last, maxGap = 0, prev = Date.now();
  for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value); const n = (buf.match(/\n\n/g) ?? []).length; if (n > events) { const now = Date.now(); first ??= now - t; last = now - t; maxGap = Math.max(maxGap, now - prev); prev = now; events = n; } }
  return { events, firstMs: first, lastMs: last, maxGapMs: maxGap };
})().catch((e) => `error ${e.cause?.code ?? e.message} after ${Date.now() - t} ms`);
console.log(JSON.stringify({ slow: await slow, sse: await sse }));
