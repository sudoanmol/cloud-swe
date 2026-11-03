import https from 'node:https';
const get = (url, headers) => new Promise((ok, fail) => https.get(url, { headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => ok({ status: res.statusCode, body: b })); }).on('error', fail));
const echo = await get('https://httpbin.org/anything', { Authorization: 'Bearer ' + process.env.PH });
const pub = await get('https://example.com', {});
console.log(JSON.stringify({ auth: JSON.parse(echo.body).headers.Authorization, public: pub.status }));
