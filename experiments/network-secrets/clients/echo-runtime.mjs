// The same fetch probe for Bun and Deno.
const PH = (globalThis.Deno ? Deno.env.get('PH') : process.env.PH);
const echo = await fetch('https://httpbin.org/anything', { headers: { Authorization: 'Bearer ' + PH } }).then((r) => r.json());
const pub = await fetch('https://example.com').then((r) => r.status);
console.log(JSON.stringify({ auth: echo.headers.Authorization, public: pub }));
