const PH = process.env.PH;
const echo = await fetch('https://httpbin.org/anything', { headers: { Authorization: 'Bearer ' + PH } }).then((r) => r.json());
const pub = await fetch('https://example.com').then((r) => r.status);
console.log(JSON.stringify({ auth: echo.headers.Authorization, public: pub }));
