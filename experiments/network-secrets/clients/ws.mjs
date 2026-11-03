// WebSocket through daemon and Worker to a public echo server.
const t = Date.now();
const result = await new Promise((resolve) => {
  const ws = new WebSocket('wss://echo.websocket.org/');
  const got = [];
  ws.onopen = () => { for (const m of ['one', 'two', 'three']) ws.send(m); };
  ws.onmessage = (e) => { got.push(String(e.data).slice(0, 40)); if (got.length >= 4) { ws.close(); resolve({ ok: true, got, ms: Date.now() - t }); } };
  ws.onerror = (e) => resolve({ ok: false, error: String(e.message ?? e.error ?? 'error') });
  setTimeout(() => resolve({ ok: false, got, error: 'timeout' }), 15000);
});
console.log(JSON.stringify(result));
