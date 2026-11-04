/**
 * Path: server/src/sandbox/egress-daemon.ts
 * Used by: server/src/sandbox/egress.ts.
 * Purpose: The egress daemon and its root setup script, shipped into the sandbox as text. The daemon terminates TLS for network-secret hosts on loopback :443 and forwards each request to the Worker's /net route, checking the end-of-body trailer.
 */

import { createHash } from 'node:crypto';

/** The config file the daemon watches, the acknowledgement it writes, and the env file trust vars. */
export const EGRESS_PATHS = {
  dir: '/etc/cloud-swe',
  config: '/etc/cloud-swe/egress.json',
  daemon: '/etc/cloud-swe/egress.mjs',
  setup: '/etc/cloud-swe/setup.sh',
  applied: '/run/cloud-swe/applied',
} as const;

const CA_CERT = '/usr/local/share/ca-certificates/cloud-swe-sandbox.crt';
const BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

// Python's clients need the combined bundle, never this CA alone, or every other host would fail.
export const TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: CA_CERT,
  REQUESTS_CA_BUNDLE: BUNDLE,
  SSL_CERT_FILE: BUNDLE,
  HTTPLIB2_CA_CERTS: BUNDLE,
  DENO_CERT: CA_CERT,
} as const;

// Root, on loopback :443. Holds no secret: the Worker swaps the placeholder in. No template literals, so it can live in
// this one. A fault ends the process, and the setup's respawn loop starts it again.
export const EGRESS_DAEMON = String.raw`
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const DIR = '/etc/cloud-swe';
const HOSTS = '/etc/hosts';
const BEGIN = '# BEGIN cloud-swe network secrets';
const END = '# END cloud-swe network secrets';
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'host', 'proxy-authorization']);
// Reasons only: never a header, URL query or body.
const log = (...parts) => console.error(new Date().toISOString(), ...parts);

let config = null;
let raw = '';
const contexts = new Map();

function writeHosts(hosts) {
  const current = fs.readFileSync(HOSTS, 'utf8');
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  let kept = start !== -1 && end > start ? current.slice(0, start) + current.slice(end + END.length) : current;
  kept = kept.replace(/\n+$/, '') + '\n';
  const lines = hosts.flatMap((host) => ['127.0.0.1 ' + host, '::1 ' + host]);
  const next = kept + (hosts.length ? [BEGIN, ...lines, END, ''].join('\n') : '');
  try {
    fs.writeFileSync(HOSTS + '.cloud-swe.next', next);
    fs.renameSync(HOSTS + '.cloud-swe.next', HOSTS);
  } catch {
    // A bind-mounted /etc/hosts (Docker) can't be replaced, only rewritten in place.
    fs.rmSync(HOSTS + '.cloud-swe.next', { force: true });
    fs.writeFileSync(HOSTS, next);
  }
}

function reload() {
  let text;
  try { text = fs.readFileSync(DIR + '/egress.json', 'utf8'); } catch { return; }
  if (text === raw) return;
  let next;
  try { next = JSON.parse(text); } catch { return; }
  if (!config || config.hash !== next.hash) {
    try { writeHosts(next.hosts); } catch (error) { log('hosts update failed:', error.code); return; }
    for (const host of contexts.keys()) if (!next.hosts.includes(host)) contexts.delete(host);
    fs.mkdirSync('/run/cloud-swe', { recursive: true });
    fs.writeFileSync('/run/cloud-swe/applied', next.hash);
    log('applied config with', next.hosts.length, 'hosts');
  }
  raw = text;
  config = next;
}

function contextFor(host) {
  if (!config || !config.hosts.includes(host)) return null;
  const cached = contexts.get(host);
  if (cached) return cached;
  const base = DIR + '/leaf-' + host;
  fs.writeFileSync(base + '.ext', 'subjectAltName=DNS:' + host + '\nbasicConstraints=critical,CA:FALSE\n' +
    'keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\n' +
    'authorityKeyIdentifier=keyid,issuer\n');
  execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', base + '.key', '-subj', '/CN=' + host, '-out', base + '.csr'], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', base + '.csr', '-CA', DIR + '/ca.crt', '-CAkey', DIR + '/ca.key',
    '-CAcreateserial', '-days', '30', '-sha256', '-extfile', base + '.ext', '-out', base + '.crt'], { stdio: 'ignore' });
  const context = tls.createSecureContext({ key: fs.readFileSync(base + '.key'), cert: fs.readFileSync(base + '.crt') });
  contexts.set(host, context);
  return context;
}

function forwardHeaders(request) {
  const listed = new Set(String(request.headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase()));
  const headers = { 'x-cloud-swe-network-token': config.token };
  for (const [name, value] of Object.entries(request.headers)) if (!HOP.has(name) && !listed.has(name)) headers[name] = value;
  return headers;
}

const target = (request) => config.workerUrl + '/net/' + config.sessionId + '/' + request.socket.servername + request.url;
const client = () => (config.workerUrl.startsWith('https:') ? https : http);

function handle(request, response) {
  if (!config) return response.writeHead(503, { 'content-type': 'text/plain' }).end('cloud-swe egress: not configured\n');
  const host = request.socket.servername;
  const nonce = crypto.randomBytes(16);
  const headers = forwardHeaders(request);
  headers['x-cloud-swe-nonce'] = nonce.toString('hex');
  // The trailer must not be compressed into the body.
  headers['accept-encoding'] = 'identity';
  const upstream = client().request(target(request), { method: request.method, headers }, (reply) => {
    const out = {};
    for (const [name, value] of Object.entries(reply.headers)) if (!HOP.has(name)) out[name] = value;
    response.writeHead(reply.statusCode ?? 502, out);
    // A cut body must reach the client as a broken connection, never a clean end.
    const broken = (why) => { log('broken response:', why, host); response.destroy(); };
    reply.on('aborted', () => broken('worker connection aborted'));
    reply.on('error', () => broken('worker connection error'));
    if (request.method === 'HEAD' || reply.statusCode === 204 || reply.statusCode === 304) return reply.pipe(response);
    let held = Buffer.alloc(0);
    reply.on('data', (chunk) => {
      held = Buffer.concat([held, chunk]);
      if (held.length > 17) {
        response.write(held.subarray(0, held.length - 17));
        held = held.subarray(held.length - 17);
      }
    });
    reply.on('end', () => {
      const clean = held.length === 17 && held.subarray(0, 16).equals(nonce) && held[16] === 0;
      if (clean) response.end();
      else broken(held.length === 17 ? 'upstream broke' : 'trailer missing');
    });
  });
  upstream.on('error', () => {
    log('worker request failed:', host);
    // Once headers are out, only a broken connection is truthful.
    if (response.headersSent) return response.destroy();
    response.writeHead(502, { 'content-type': 'text/plain' }).end('cloud-swe egress: the proxy is unreachable\n');
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}

const server = http.createServer(handle);

// WebSockets: forward the upgrade, then splice the sockets once both sides switch protocols. No trailer.
server.on('upgrade', (request, socket, head) => {
  if (!config) return socket.destroy();
  const headers = forwardHeaders(request);
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  const upstream = client().request(target(request), { headers });
  upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (let i = 0; i < reply.rawHeaders.length; i += 2) lines.push(reply.rawHeaders[i] + ': ' + reply.rawHeaders[i + 1]);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
  });
  upstream.on('response', (reply) => socket.end('HTTP/1.1 ' + reply.statusCode + ' Upgrade Refused\r\nconnection: close\r\n\r\n'));
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

const listener = () => tls.createServer({
  ALPNProtocols: ['http/1.1'],
  SNICallback(name, callback) {
    try {
      const context = contextFor(name.toLowerCase());
      callback(context ? null : new Error('not a network-secret host'), context ?? undefined);
    } catch (error) {
      log('certificate failed:', name);
      callback(error);
    }
  },
}, (socket) => server.emit('connection', socket));

reload();
setInterval(reload, 250);
listener().on('error', (error) => { log('listen failed:', error.code); process.exit(1); }).listen(443, '127.0.0.1');
listener().on('error', (error) => log('ipv6 listener:', error.code)).listen(443, '::1');
fs.writeFileSync(DIR + '/daemon.pid', String(process.pid));
log('egress daemon listening');
`;

// Root. Run when the sandbox's setup version differs: CA (kept if present), system trust, profile vars, and the daemon
// under a respawn loop, replacing an older loop.
export const SETUP_SCRIPT = String.raw`
set -eu
D=/etc/cloud-swe
mkdir -p "$D" /run/cloud-swe /usr/local/share/ca-certificates /etc/profile.d
chmod 700 "$D"
mv -f "$D/egress.mjs.next" "$D/egress.mjs"
if [ ! -f "$D/ca.key" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -keyout "$D/ca.key" -out "$D/ca.crt" -subj "/CN=cloud-swe sandbox CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" 2>/dev/null
  chmod 600 "$D/ca.key"
fi
install -m 644 "$D/ca.crt" /usr/local/share/ca-certificates/cloud-swe-sandbox.crt
update-ca-certificates >/dev/null 2>&1
cat > /etc/profile.d/cloud-swe.sh <<'PROFILE'
export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/cloud-swe-sandbox.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export HTTPLIB2_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export DENO_CERT=/usr/local/share/ca-certificates/cloud-swe-sandbox.crt
PROFILE
for pidfile in "$D/loop.pid" "$D/daemon.pid"; do
  if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; fi
done
setsid nohup bash -c 'while :; do node /etc/cloud-swe/egress.mjs; sleep 1; done' \
  </dev/null >>/var/log/cloud-swe-egress.log 2>&1 &
echo $! > "$D/loop.pid"
echo "$1" > "$D/setup-version"
`;

/** Changes whenever the daemon or setup does, so a sandbox set up by an older deploy is set up again. */
export const SETUP_VERSION = createHash('sha256')
  .update(EGRESS_DAEMON + SETUP_SCRIPT)
  .digest('hex')
  .slice(0, 16);
