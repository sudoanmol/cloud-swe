// More SDKs at their default hosts with the placeholder: each should get that provider's auth error, not a TLS or network error.
const PH = process.env.PH; const out = {};
const probe = async (name, call) => { try { await call(); out[name] = 'unexpected success'; } catch (e) { out[name] = `${e.constructor?.name} ${e.status ?? e.statusCode ?? e.code ?? ''} ${String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 110)}`; } };
const load = async (name) => (await import(name));
await probe('@google/genai', async () => { const { GoogleGenAI } = await load('@google/genai'); await new GoogleGenAI({ apiKey: PH }).models.list(); });
await probe('groq-sdk', async () => { const Groq = (await load('groq-sdk')).default; await new Groq({ apiKey: PH }).models.list(); });
await probe('@mistralai/mistralai', async () => { const { Mistral } = await load('@mistralai/mistralai'); await new Mistral({ apiKey: PH }).models.list(); });
await probe('cohere-ai', async () => { const { CohereClient } = await load('cohere-ai'); await new CohereClient({ token: PH }).models.list(); });
await probe('resend', async () => { const { Resend } = await load('resend'); const r = await new Resend(PH).domains.list(); if (r.error) throw new Error(JSON.stringify(r.error)); });
await probe('@slack/web-api', async () => { const { WebClient } = await load('@slack/web-api'); await new WebClient(PH).auth.test(); });
await probe('@notionhq/client', async () => { const { Client } = await load('@notionhq/client'); await new Client({ auth: PH }).users.me(); });
await probe('replicate', async () => { const Replicate = (await load('replicate')).default; await new Replicate({ auth: PH }).accounts.current(); });
await probe('@pinecone-database/pinecone', async () => { const { Pinecone } = await load('@pinecone-database/pinecone'); await new Pinecone({ apiKey: PH }).listIndexes(); });
await probe('axios', async () => { const axios = (await load('axios')).default; await axios.get('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + PH } }); });
console.log(JSON.stringify(out, null, 1));
