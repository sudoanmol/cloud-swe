/**
 * Path: server/src/sandbox/egress-daemon.ts
 * Used by: server/src/sandbox/{egress,network-proxy}.ts.
 * Purpose: The egress daemon and its root setup script, shipped into the sandbox as text. The daemon terminates TLS for network-secret hosts on loopback :443 and forwards each request to the Worker's /net route, checking the end-of-body trailer.
 */

import { createHash } from 'node:crypto';

const DIR = '/etc/cloud-swe';

// File names in DIR. The shipped texts join them to DIR themselves, so their bytes and SETUP_VERSION stay put.
const CONFIG = 'egress.json';
const NEXT_DAEMON = 'egress.mjs.next';
const VERSION_FILE = 'setup-version';

/** The config file the daemon watches, the acknowledgement it writes, and the env file trust vars. */
export const EGRESS_PATHS = {
  dir: DIR,
  config: `${DIR}/${CONFIG}`,
  daemon: `${DIR}/egress.mjs`,
  nextDaemon: `${DIR}/${NEXT_DAEMON}`,
  setup: `${DIR}/setup.sh`,
  setupVersion: `${DIR}/${VERSION_FILE}`,
  run: '/run/cloud-swe',
  applied: '/run/cloud-swe/applied',
} as const;

export type EgressConfig = { workerUrl: string; sessionId: string; token: string; hosts: string[]; hash: string };

// The wire protocol between the daemon and the Worker's /net route (network-proxy.ts).
export const TOKEN_HEADER = 'x-cloud-swe-network-token';
export const NONCE_HEADER = 'x-cloud-swe-nonce';
export const NONCE_BYTES = 16;

// After a proxied body: the request's nonce, then one status byte (0 clean, 1 broken).
export const TRAILER_BYTES = NONCE_BYTES + 1;

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

const DIR = '${EGRESS_PATHS.dir}';
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
  try { text = fs.readFileSync(DIR + '/${CONFIG}', 'utf8'); } catch { return; }
  if (text === raw) return;
  let next;
  try { next = JSON.parse(text); } catch { return; }
  if (!config || config.hash !== next.hash) {
    try { writeHosts(next.hosts); } catch (error) { log('hosts update failed:', error.code); return; }
    for (const host of contexts.keys()) if (!next.hosts.includes(host)) contexts.delete(host);
    fs.mkdirSync('${EGRESS_PATHS.run}', { recursive: true });
    fs.writeFileSync('${EGRESS_PATHS.applied}', next.hash);
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
  const headers = { '${TOKEN_HEADER}': config.token };
  for (const [name, value] of Object.entries(request.headers)) if (!HOP.has(name) && !listed.has(name)) headers[name] = value;
  return headers;
}

const target = (request) => config.workerUrl + '/net/' + config.sessionId + '/' + request.socket.servername + request.url;
const client = () => (config.workerUrl.startsWith('https:') ? https : http);

function handle(request, response) {
  if (!config) return response.writeHead(503, { 'content-type': 'text/plain' }).end('cloud-swe egress: not configured\n');
  const host = request.socket.servername;
  const nonce = crypto.randomBytes(${NONCE_BYTES});
  const headers = forwardHeaders(request);
  headers['${NONCE_HEADER}'] = nonce.toString('hex');
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
      if (held.length > ${TRAILER_BYTES}) {
        response.write(held.subarray(0, held.length - ${TRAILER_BYTES}));
        held = held.subarray(held.length - ${TRAILER_BYTES});
      }
    });
    reply.on('end', () => {
      const clean = held.length === ${TRAILER_BYTES} && held.subarray(0, ${NONCE_BYTES}).equals(nonce) && held[${NONCE_BYTES}] === 0;
      if (clean) response.end();
      else broken(held.length === ${TRAILER_BYTES} ? 'upstream broke' : 'trailer missing');
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
D=${EGRESS_PATHS.dir}
mkdir -p "$D" ${EGRESS_PATHS.run} /usr/local/share/ca-certificates /etc/profile.d
chmod 700 "$D"
mv -f "$D/${NEXT_DAEMON}" "$D/egress.mjs"
if [ ! -f "$D/ca.key" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -keyout "$D/ca.key" -out "$D/ca.crt" -subj "/CN=cloud-swe sandbox CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" 2>/dev/null
  chmod 600 "$D/ca.key"
fi
install -m 644 "$D/ca.crt" ${CA_CERT}
update-ca-certificates >/dev/null 2>&1
cat > /etc/profile.d/cloud-swe.sh <<'PROFILE'
${Object.entries(TRUST_ENV)
  .map(([name, value]) => `export ${name}=${value}`)
  .join('\n')}
PROFILE
for pidfile in "$D/loop.pid" "$D/daemon.pid"; do
  if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; fi
done
setsid nohup bash -c 'while :; do node ${EGRESS_PATHS.daemon}; sleep 1; done' \
  </dev/null >>/var/log/cloud-swe-egress.log 2>&1 &
echo $! > "$D/loop.pid"
echo "$1" > "$D/${VERSION_FILE}"
`;

/** Changes whenever the daemon or setup does, so a sandbox set up by an older deploy is set up again. */
export const SETUP_VERSION = createHash('sha256')
  .update(EGRESS_DAEMON + SETUP_SCRIPT)
  .digest('hex')
  .slice(0, 16);
