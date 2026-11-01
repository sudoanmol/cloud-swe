#!/usr/bin/env node
// Evidence only, not part of the app or its checks. See README.md in this folder.
// Starts real Claude Code and Pi in panes of an isolated Herdr session ("cswe2e"), drives them only through Herdr, and
// prints what each side saw. Uses a dummy token and a fake model API on localhost, so it needs no login and spends nothing.
// Never touches your default Herdr session. Run from this folder: node run.cjs
const { execFileSync, spawn } = require('node:child_process'); const fs = require('node:fs'); const net = require('node:net'); const path = require('node:path'); const os = require('node:os');
const SESSION = 'cswe2e'; const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-attach-')));
for (const d of ['claude', 'pi/extensions', 'proj-claude', 'proj-pi']) fs.mkdirSync(path.join(R, d), { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HERDR|CLAUDE|ANTHROPIC|PI_)/.test(k)));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (...a) => { try { return JSON.parse(execFileSync('herdr', ['--session', SESSION, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })); } catch (e) { return { failed: true, err: `${e.stderr ?? ''}${e.stdout ?? ''}`.slice(0, 300) || e.message.slice(0, 200) }; } };
const text = (p, lines = 40) => { try { return execFileSync('herdr', ['--session', SESSION, 'pane', 'read', p, '--source', 'recent-unwrapped', '--lines', String(lines)], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }); } catch (e) { return 'READ FAILED ' + (e.stderr ?? e.message).slice(0, 200); } };
const view = (s, n = 10) => s.split('\n').filter((l) => l.trim() && !/^[─╌ ]+$/.test(l)).slice(-n).map((l) => '   | ' + l.slice(0, 100)).join('\n');
const agent = (p) => { const r = H('agent', 'get', p); const a = r.result?.agent ?? r.result; return r.failed ? { failed: r.err } : { kind: a.agent, status: a.agent_status ?? a.status, session: a.agent_session?.value, cwd: a.foreground_cwd }; };
const until = async (p, want, ms = 30000) => { const end = Date.now() + ms; let a; while (Date.now() < end) { a = agent(p); if (want.includes(a.status)) return a; await sleep(300); } return { ...a, timedOut: true }; };
const wire = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const result = {}; const check = (name, ok, note = '') => { result[name] = ok; log(ok ? 'PASS' : 'FAIL', name, note); };
(async () => {
  const fakeOut = path.join(R, 'wire.jsonl'); fs.writeFileSync(fakeOut, '');
  const fake = spawn('node', [path.join(__dirname, 'fake-model-api.mjs'), fakeOut], { env, stdio: 'ignore' });
  const srv = spawn('herdr', ['--session', SESSION, 'server'], { env, stdio: 'ignore', detached: true }); srv.unref();
  for (let i = 0; i < 30 && H('workspace', 'list').failed; i++) await sleep(500);
  log('server', JSON.stringify(H('workspace', 'list')).slice(0, 140));
  const events = []; let sub;
  const watch = (p) => { const s = net.connect(path.join(os.homedir(), '.config/herdr/sessions', SESSION, 'herdr.sock')); s.on('error', (e) => log('events error', e.message)); let b = ''; s.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); try { const m = JSON.parse(l); if (m.result) { log('subscription ack', JSON.stringify(m.result).slice(0,120)); continue; } if (m.error) { log('subscription error', JSON.stringify(m.error).slice(0,200)); continue; } events.push(m.data?.agent_status ?? m.event ?? m.type ?? 'event'); } catch {} } }); s.write(JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.agent_status_changed', pane_id: p }] } }) + '\n'); return s; };
  try {
    // ------- Claude Code
    fs.writeFileSync(path.join(R, 'claude/.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }));
    const hl = path.join(R, 'hooks.jsonl'); fs.writeFileSync(hl, ''); const logHook = { type: 'command', command: `cat >> ${hl}; echo >> ${hl}` };
    fs.writeFileSync(path.join(R, 'claude/settings.json'), JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `bash '${os.homedir()}/.claude/hooks/herdr-agent-state.sh' session` }, logHook] }], PermissionRequest: [{ hooks: [logHook] }] } }));
    const w1 = H('workspace', 'create', '--cwd', path.join(R, 'proj-claude'), '--label', 'claude', '--no-focus', '--env', `CLAUDE_CONFIG_DIR=${R}/claude`, '--env', 'ANTHROPIC_AUTH_TOKEN=DUMMY', '--env', 'ANTHROPIC_BASE_URL=http://127.0.0.1:19999', '--env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', '--env', 'DISABLE_AUTOUPDATER=1', '--env', 'BROWSER=/usr/bin/true');
    const c = w1.result?.root_pane?.pane_id; log('claude pane', c, w1.failed ? w1.err : '');
    await sleep(2500);
    H('pane', 'run', c, 'claude --model claude-sonnet-5-5 --permission-mode default'); // Started like a person would, not by the app.
    let ready = false; for (let i = 0; i < 25 && !ready; i++) { await sleep(1500); const s = text(c, 25); if (/Select login method|Paste code/.test(s)) { log('STOP at login'); break; } if (/Yes, I trust this folder/.test(s)) { H('pane', 'send-keys', c, 'down'); await sleep(400); H('pane', 'send-keys', c, 'enter'); continue; } if (/Dark mode \(colorblind/.test(s)) { H('pane', 'send-keys', c, 'enter'); continue; } const a = agent(c); if (a.kind === 'claude' && ['idle', 'done'].includes(a.status)) ready = true; }
    log('claude screen at start\n' + view(text(c, 25), 8)); log('herdr sees', JSON.stringify(agent(c)));
    check('claude: Herdr finds the session started by hand', ready && agent(c).kind === 'claude');
    sub = watch(c); await sleep(500); // The Herdr calls below block this process, so let the subscribe request go out first.
    log('list', JSON.stringify((H('agent', 'list').result?.agents ?? []).map((a) => ({ pane: a.pane_id, agent: a.agent, status: a.agent_status, s: a.agent_session?.value?.slice(0, 8) }))));
    const start = wire(fakeOut).length;
    const p1 = H('agent', 'prompt', c, 'hello from the phone', '--wait', '--timeout', '30000'); log('prompt result', p1.failed ? p1.err.slice(0, 120) : 'ok');
    await sleep(500); let scr = text(c); log('mac screen after phone message\n' + view(scr, 8));
    check('claude: phone message appears in the Mac terminal', /hello from the phone/.test(scr)); check('claude: reply appears in the Mac terminal', /REPLY-TO\[/.test(scr)); // The fake can't read Claude's wrapped first message, so it echoes nothing there.
    const sessId = agent(c).session ?? wire0(hl); const tf = () => { const dir = path.join(R, 'claude/projects'); const hit = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : []; return hit[0]; };
    function wire0(f) { return wire(f).find((h) => h.hook_event_name === 'SessionStart')?.session_id; }
    log('session id from herdr', agent(c).session, 'from hook', wire0(hl), 'transcript', tf() ? path.basename(tf()) : 'none');
    check('claude: Herdr reports the session ID that names the transcript', !!agent(c).session && tf()?.includes(agent(c).session));
    const tr = () => fs.readFileSync(tf(), 'utf8');
    check('claude: transcript has both sides', /hello from the phone/.test(tr()) && /REPLY-TO\[/.test(tr()));
    // Live preview vs transcript during a slow reply.
    H('agent', 'prompt', c, 'please write slowly'); await sleep(6000);
    const midScr = text(c, 60); const midWords = (midScr.match(/word\d+/g) ?? []).length; const midT = (tr().match(/word\d+/g) ?? []).length; const midA = agent(c);
    log(`mid reply: state=${midA.status} words on screen=${midWords} words in transcript=${midT}`);
    check('claude: screen shows the reply while it is being written', midWords > 0 && midWords < 60, `${midWords} of 60`);
    log('transcript during the reply', midT === 0 ? 'none yet, as expected: whole messages only' : `${midT} words`);
    const a2 = await until(c, ['idle', 'done']); await sleep(800); const endT = (tr().match(/word\d+/g) ?? []).length; check('claude: full message lands in the transcript when finished', endT >= 60, `${endT}`);
    // Approval.
    H('agent', 'prompt', c, 'please run the tool'); const blocked = await until(c, ['blocked'], 15000); await sleep(800); scr = text(c, 25); log('blocked\n' + view(scr, 10));
    check('claude: Herdr reports the approval as blocked', blocked.status === 'blocked');
    check('claude: hook gives the exact tool and command', wire(hl).some((h) => h.hook_event_name === 'PermissionRequest' && /tool-ran-ok/.test(JSON.stringify(h.tool_input))));
    const refused = H('agent', 'prompt', c, 'should be refused'); check('claude: a message during an approval is refused', /agent_blocked/.test(JSON.stringify(refused)), JSON.stringify(refused).slice(0, 110));
    const yes = /❯\s*1\.\s*Yes/.test(scr); check('claude: dialog is readable, with Yes selected', yes);
    if (yes) H('agent', 'send-keys', c, 'enter'); await until(c, ['idle', 'done'], 15000); await sleep(800); scr = text(c, 25);
    check('claude: approving from the phone runs the tool', wire(fakeOut).some((l) => l.isResult && /tool-ran-ok/.test(l.result ?? '')));
    // Deny from the phone.
    const rb = wire(fakeOut).filter((l) => l.isResult).length; const projFiles = () => fs.readdirSync(path.join(R, 'proj-claude')).filter((f) => f.startsWith('approved-')).length; const fb = projFiles();
    H('agent', 'prompt', c, 'please run the tool once more'); const b2 = await until(c, ['blocked'], 15000); await sleep(800); const dlg = text(c, 20); log('deny dialog\n' + view(dlg, 8));
    H('agent', 'send-keys', c, 'esc'); await until(c, ['idle', 'done'], 15000); await sleep(800);
    check('claude: denying from the phone stops the tool', b2.status === 'blocked' && projFiles() === fb, `files ${fb}->${projFiles()}`);
    // Typed on the Mac.
    H('pane', 'send-text', c, 'typed on the mac'); await sleep(300); H('pane', 'send-keys', c, 'enter'); await sleep(600); const typedA = await until(c, ['idle', 'done']); await sleep(800);
    check('claude: Mac-typed message reaches the transcript the phone reads', /typed on the mac/.test(tr()));
    // Interrupt from the phone.
    H('agent', 'prompt', c, 'please write slowly again'); await sleep(2500); H('agent', 'send-keys', c, 'esc'); const stopped = await until(c, ['idle', 'done'], 8000); check('claude: phone can interrupt', !stopped.timedOut, JSON.stringify(stopped.status));
    await sleep(500);
    // Half-typed draft on the Mac.
    H('pane', 'send-text', c, 'HALFDRAFT'); await sleep(400); const before = wire(fakeOut).length; H('agent', 'prompt', c, 'FROMPHONE', '--wait', '--timeout', '20000'); await sleep(800);
    const lastCalls = wire(fakeOut).slice(before); log('draft test, model received', JSON.stringify(lastCalls.map((l) => l.text))); log('draft screen\n' + view(text(c, 12), 5));
    result['claude: draft collision (true = no merge)'] = !lastCalls.some((l) => /HALFDRAFT/.test(l.text) && /FROMPHONE/.test(l.text)); log('INFO draft merged =', !result['claude: draft collision (true = no merge)']);
    const counts = wire(fakeOut).slice(start).map((l) => l.n); check('claude: every message continues one conversation', counts.every((n, i) => !i || n > counts[i - 1]), counts.join(','));
    log('status events seen', [...new Set(events)].join(','), 'count', events.length);
    check('claude: live state arrives as pushed events', events.length > 0);
    // ------- Pi
    const pd = path.join(R, 'pi'); fs.writeFileSync(path.join(pd, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: 'http://127.0.0.1:19999', api: 'anthropic-messages', apiKey: 'DUMMY', models: [{ id: 'fake-1', name: 'fake', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 }] } } }));
    fs.copyFileSync(path.join(os.homedir(), '.pi/agent/extensions/herdr-agent-state.ts'), path.join(pd, 'extensions/herdr-agent-state.ts'));
    const pl = path.join(R, 'pi-events.jsonl'); fs.writeFileSync(pl, '');
    fs.writeFileSync(path.join(pd, 'extensions/bridge-probe.ts'), `import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';\nexport default function (pi: any) {\n const w = (o: any) => appendFileSync(${JSON.stringify(pl)}, JSON.stringify({ t: Date.now(), ...o }) + '\\n');\n pi.on('session_start', (_e: any, ctx: any) => { w({ e: 'session_start', file: ctx.sessionManager.getSessionFile() }); setInterval(() => { const f = ${JSON.stringify(path.join(R, 'pi-inbox'))}; if (existsSync(f)) { const m = readFileSync(f, 'utf8'); rmSync(f); pi.sendUserMessage(m); } }, 200); });\n pi.on('message_update', (e: any) => { const a = e.assistantMessageEvent; if (a?.type === 'text_delta') w({ e: 'delta', d: a.delta }); });\n pi.on('message_end', (e: any) => w({ e: 'message_end', role: e.message?.role }));\n pi.on('tool_execution_start', (e: any) => w({ e: 'tool', name: e.toolName }));\n}\n`);
    const w2 = H('workspace', 'create', '--cwd', path.join(R, 'proj-pi'), '--label', 'pi', '--no-focus', '--env', `PI_CODING_AGENT_DIR=${pd}`, '--env', 'PI_OFFLINE=1');
    const p = w2.result?.root_pane?.pane_id; log('pi pane', p, w2.failed ? w2.err : ''); await sleep(2500);
    H('pane', 'run', p, 'pi --model fake/fake-1');
    let pr = false; for (let i = 0; i < 25 && !pr; i++) { await sleep(1000); const a = agent(p); if (a.kind === 'pi' && ['idle', 'done'].includes(a.status)) pr = true; }
    log('pi screen at start\n' + view(text(p, 25), 6)); log('herdr sees', JSON.stringify(agent(p)));
    check('pi: Herdr finds the session started by hand', pr);
    const ps = wire(fakeOut).length;
    log('prompt', JSON.stringify(H('agent', 'prompt', p, 'hello pi from the phone', '--wait', '--timeout', '30000')).slice(0, 120)); await sleep(400); scr = text(p);
    log('mac screen\n' + view(scr, 7));
    check('pi: phone message appears in the Mac terminal', /hello pi from the phone/.test(scr)); check('pi: reply appears in the Mac terminal', /REPLY-TO\[hello pi from the phone\]/.test(scr));
    H('agent', 'prompt', p, 'please write slowly'); await sleep(3500); const pm = (text(p, 60).match(/word\d+/g) ?? []).length; const pdeltas = wire(pl).filter((l) => l.e === 'delta' && /word/.test(l.d)).length; log(`pi mid reply: words on screen=${pm}, tokens the extension already has=${pdeltas}`);
    check('pi: extension gets tokens while the reply is being written', pdeltas > 0 && pdeltas < 60, `${pdeltas} of 60`);
    await until(p, ['idle', 'done']); await sleep(500); const tot = wire(pl).filter((l) => l.e === 'delta' && /word/.test(l.d)); const gaps = tot.slice(1).map((l, i) => l.t - tot[i].t); check('pi: all tokens arrive', tot.length === 60, `${tot.length}, median gap ${gaps.sort((a, b) => a - b)[gaps.length >> 1]} ms`);
    fs.writeFileSync(path.join(R, 'pi-inbox'), 'typed by the extension bridge'); await sleep(1500); await until(p, ['idle', 'done']); await sleep(400); scr = text(p); check('pi: sendUserMessage through the extension also shows on the Mac', /typed by the extension bridge/.test(scr));
    H('pane', 'send-text', p, 'typed on the mac for pi'); await sleep(300); H('pane', 'send-keys', p, 'enter'); await sleep(1500); await until(p, ['idle', 'done']); await sleep(400);
    const file = wire(pl).find((l) => l.e === 'session_start')?.file; check('pi: Mac-typed message reaches the session file', !!file && /typed on the mac for pi/.test(fs.readFileSync(file, 'utf8')));
    check('pi: Mac-typed reply reaches the extension', wire(pl).some((l) => l.e === 'delta' && /typed/.test(l.d)));
    H('pane', 'send-text', p, 'PIDRAFT'); await sleep(400); const pb = wire(fakeOut).length; H('agent', 'prompt', p, 'PIPHONE', '--wait', '--timeout', '20000'); await sleep(600); log('pi draft test, model received', JSON.stringify(wire(fakeOut).slice(pb).map((l) => l.text)));
    const pc = wire(fakeOut).slice(ps).map((l) => l.n); check('pi: every message continues one conversation', pc.every((n, i) => !i || n > pc[i - 1]), pc.join(','));
    // ------- Started from the phone, continued on the Mac with no resume.
    const startFromPhone = async (kind, label, wenv, args) => {
      const w = H('workspace', 'create', '--cwd', path.join(R, label), '--label', label, '--no-focus', ...wenv); const pane = w.result?.root_pane?.pane_id; await sleep(2500);
      const st = H('agent', 'start', label.replace(/[^a-z]/g, ''), '--kind', kind, '--pane', pane, '--timeout', '30000', '--', ...args); log(kind, 'agent start', JSON.stringify(st).slice(0, 170));
      for (let i = 0; i < 20; i++) { const s = text(pane, 25); if (/Yes, I trust this folder/.test(s)) { log(kind, 'trust prompt shown\n' + view(s, 6)); H('pane', 'send-keys', pane, 'down'); await sleep(400); H('pane', 'send-keys', pane, 'enter'); } const a = agent(pane); if (['idle', 'done'].includes(a.status)) break; await sleep(1000); }
      const n0 = wire(fakeOut).length; const m1 = `${kind} started on phone`; const r1 = H('agent', 'prompt', pane, m1, '--wait', '--timeout', '30000'); await sleep(600); let sc = text(pane);
      check(`${kind} from phone: first message works`, sc.includes(m1) && (sc.includes(`REPLY-TO[${m1}]`) || (kind === 'claude' && sc.includes('REPLY-TO['))), r1.failed ? r1.err.slice(0, 120) : '');
      const m2 = `${kind} back at the mac`; H('pane', 'send-text', pane, m2); await sleep(300); H('pane', 'send-keys', pane, 'enter'); await sleep(1500); await until(pane, ['idle', 'done']); await sleep(500); sc = text(pane);
      check(`${kind} from phone: Mac continues it in the same pane with no resume`, sc.includes(`REPLY-TO[${m2}]`));
      const m3 = `${kind} phone again`; H('agent', 'prompt', pane, m3, '--wait', '--timeout', '30000'); await sleep(500); sc = text(pane); check(`${kind} from phone: phone continues after the Mac`, sc.includes(`REPLY-TO[${m3}]`));
      const ns = wire(fakeOut).slice(n0).map((l) => l.n); check(`${kind} from phone: all three are one conversation`, ns.length === 3 && ns[0] < ns[1] && ns[1] < ns[2], ns.join(','));
      log(`${kind} mac screen\n` + view(sc, 9));
    };
    fs.mkdirSync(path.join(R, 'phone-claude')); fs.mkdirSync(path.join(R, 'phone-pi'));
    await startFromPhone('claude', 'phone-claude', ['--env', `CLAUDE_CONFIG_DIR=${R}/claude`, '--env', 'ANTHROPIC_AUTH_TOKEN=DUMMY', '--env', 'ANTHROPIC_BASE_URL=http://127.0.0.1:19999', '--env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', '--env', 'DISABLE_AUTOUPDATER=1', '--env', 'BROWSER=/usr/bin/true'], ['--model', 'claude-sonnet-5-5', '--permission-mode', 'default']);
    await startFromPhone('pi', 'phone-pi', ['--env', `PI_CODING_AGENT_DIR=${pd}`, '--env', 'PI_OFFLINE=1'], ['--model', 'fake/fake-1']);
    log('agent_session for pi', JSON.stringify(agent(p).session), 'file', path.basename(file ?? 'none'));
  } catch (e) { log('ERROR', e.stack?.slice(0, 500)); } finally {
    sub?.destroy(); fake.kill(); log('stop', JSON.stringify(H('session', 'stop', SESSION)).slice(0, 90)); try { execFileSync('herdr', ['session', 'stop', SESSION], { env, stdio: 'ignore' }); } catch {} await sleep(1000); try { execFileSync('herdr', ['session', 'delete', SESSION], { env, stdio: 'ignore' }); } catch {}
    log('sessions now', execFileSync('herdr', ['session', 'list', '--json'], { env, encoding: 'utf8' }).replace(/\s+/g, ' ').slice(0, 140));
    fs.rmSync(R, { recursive: true, force: true }); const v = Object.entries(result); log(`SUMMARY ${v.filter(([, x]) => x).length} of ${v.length}`); for (const [k, x] of v.filter(([, x]) => !x)) log('NOT OK:', k);
  }
})();
