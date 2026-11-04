const { PH, SLOW, DUMMY } = process.env; const t = Date.now();
const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => fetch(`https://${SLOW}/echo?i=${i}`, { headers: { Authorization: 'Bearer ' + PH } }).then((r) => r.json())));
const ok = results.filter((r) => r.status === 'fulfilled' && r.value.headers.Authorization === 'Bearer ' + DUMMY).length;
console.log(JSON.stringify({ parallel: 100, swappedOk: ok, failed: results.filter((r) => r.status === 'rejected').map((r) => String(r.reason.cause?.code ?? r.reason)).slice(0, 3), ms: Date.now() - t }));
