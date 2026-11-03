const { PH, SLOW } = process.env; const auth = { Authorization: 'Bearer ' + PH }; const out = {};
for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  const r = await fetch(`https://${SLOW}/echo`, { method, headers: { ...auth, 'content-type': 'text/plain' }, body: method === 'GET' ? undefined : 'abc' });
  const j = await r.json(); out[method] = `${r.status} method=${j.method} body=${j.bodyBytes} swapped=${j.headers.Authorization === 'Bearer ' + process.env.DUMMY}`;
}
const head = await fetch(`https://${SLOW}/echo`, { method: 'HEAD' }); out.HEAD = `${head.status} x-head=${head.headers.get('x-head')}`;
const cookies = await fetch(`https://${SLOW}/cookies`); out.setCookies = cookies.headers.getSetCookie();
const gz = await fetch('https://httpbin.org/gzip', { headers: auth }); out.gzip = `${gz.status} gzipped=${(await gz.json()).gzipped}`;
const q = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${PH}`); out.queryKeyGoogle = `${q.status} ${(await q.text()).replace(/\s+/g, ' ').slice(0, 90)}`;
console.log(JSON.stringify(out, null, 1));
