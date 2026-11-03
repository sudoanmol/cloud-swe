// SSE through the full path: arrival times of the first chunks of a live event stream.
const t = Date.now(); const ac = new AbortController(); setTimeout(() => ac.abort(), 5000); const at = [];
try {
  const r = await fetch('https://stream.wikimedia.org/v2/stream/recentchange', { signal: ac.signal, headers: { accept: 'text/event-stream', Authorization: 'Bearer ' + process.env.PH } });
  const reader = r.body.getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; at.push(Date.now() - t); }
} catch {}
const spread = at.length ? at[at.length - 1] - at[0] : 0;
console.log(JSON.stringify({ chunks: at.length, first: at.slice(0, 5), last: at.at(-1), spreadMs: spread }));
