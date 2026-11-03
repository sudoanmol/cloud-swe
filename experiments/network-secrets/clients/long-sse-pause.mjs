const t = Date.now(); let events = 0, buf = '';
try {
  const r = await fetch(`https://${process.env.SLOW}/sse?n=60`, { headers: { Authorization: 'Bearer ' + process.env.PH } });
  const reader = r.body.getReader(); const dec = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value); const n = (buf.match(/\n\n/g) ?? []).length; if (n !== events) { events = n; console.log(`event ${events} at ${Date.now() - t} ms`); } }
  console.log(`stream ended normally: ${events} events in ${Date.now() - t} ms`);
} catch (e) { console.log(`stream error after ${events} events at ${Date.now() - t} ms: ${e.cause?.code ?? e.message}`); }
