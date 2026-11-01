// Scripted Anthropic API on localhost. Streams text in small pieces and logs what each conversation request carried.
import { createServer } from 'node:http'; import { appendFileSync } from 'node:fs';
const wire = process.argv[2]; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastText = (m) => { const c = m?.content; const parts = typeof c === 'string' ? [c] : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text); return parts.map((x) => x.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter((x) => x && !x.startsWith('# ')).at(-1) ?? ''; };
createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', async () => {
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url.includes('count_tokens') ? '{"input_tokens":1}' : '{}'); }
  const body = JSON.parse(raw); const last = body.messages.at(-1); const tool = (body.tools ?? []).find((t) => /^bash$/i.test(t.name));
  const isResult = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result'); let text = ''; for (const m of [...body.messages].reverse()) { if (m.role !== 'user') break; text = lastText(m); if (text) break; }
  if (tool) appendFileSync(wire, JSON.stringify({ n: body.messages.length, text: text.slice(0, 120), isResult, result: isResult ? JSON.stringify(last.content.find((b) => b.type === 'tool_result').content).slice(0, 80) : undefined }) + '\n');
  const wantTool = tool && !isResult && /run the tool/.test(text); const slow = /write slowly/.test(text);
  const reply = !tool ? 'ok' : isResult ? 'the tool finished' : slow ? Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') : `REPLY-TO[${text.slice(0, 60)}]`;
  const message = { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' })); }
  if (tool) await sleep(1500); // A real model takes a moment before its first token.
  res.writeHead(200, { 'content-type': 'text/event-stream' }); const send = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
  send('message_start', { message });
  if (wantTool) { send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `tu_${Date.now()}`, name: tool.name, input: {} } }); send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'touch ./approved-' + Date.now() + ' && echo tool-ran-ok', description: 'probe' }) } }); }
  else { send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); const parts = reply.match(/\S+\s*/g) ?? [reply]; for (const p of parts) { if (res.destroyed) return; send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: p } }); await sleep(slow ? 150 : 20); } }
  send('content_block_stop', { index: 0 }); send('message_delta', { delta: { stop_reason: wantTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }); send('message_stop', {}); res.end();
}); }).listen(19999, '127.0.0.1');
