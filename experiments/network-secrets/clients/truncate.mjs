// Reads an SSE stream while the upstream server is killed mid-stream: a truncated body must surface as an error.
const t = Date.now(); let events = 0, buf = '';
try {
  const r = await fetch(`https://${process.env.SLOW}/sse?n=60`, { headers: { Authorization: 'Bearer ' + process.env.PH } });
  const reader = r.body.getReader(); const dec = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value); events = (buf.match(/\n\n/g) ?? []).length; }
  console.log(`CLEAN END after ${events} events at ${Date.now() - t} ms (truncation hidden)`);
} catch (e) { console.log(`ERROR after ${events} events at ${Date.now() - t} ms: ${e.cause?.code ?? e.message} (truncation visible)`); }
