// Real keys, swapped in by the Worker: the sandbox only ever holds the placeholder.
import Anthropic from '@anthropic-ai/sdk';
const { PH } = process.env; const out = {};
const client = new Anthropic({ apiKey: PH });
for (const model of ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-3-5-haiku-latest']) {
  try {
    const t = Date.now(); const deltas = [];
    const stream = client.messages.stream({ model, max_tokens: 120, messages: [{ role: 'user', content: 'Count from 1 to 40, separated by spaces.' }] });
    stream.on('text', () => deltas.push(Date.now() - t));
    const final = await stream.finalMessage();
    out.anthropicStream = { model, stop: final.stop_reason, textDeltas: deltas.length, firstDeltaMs: deltas[0], lastDeltaMs: deltas.at(-1), text: final.content[0]?.text?.slice(0, 40) };
    break;
  } catch (e) { out[`anthropic ${model}`] = `${e.status ?? ''} ${String(e.message).slice(0, 100)}`; }
}
const fc = await fetch('https://api.firecrawl.dev/v1/team/credit-usage', { headers: { Authorization: 'Bearer ' + PH } });
out.firecrawl = `${fc.status} ${(await fc.text()).slice(0, 80)}`;
const e2b = await fetch('https://api.e2b.dev/sandboxes', { headers: { 'X-API-Key': PH } });
out.e2b = `${e2b.status} sandboxes=${e2b.ok ? (await e2b.json()).length : (await e2b.text()).slice(0, 80)}`;
console.log(JSON.stringify(out, null, 1));
