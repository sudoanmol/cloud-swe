// Spike egress daemon: runs as root in the sandbox on loopback :443. Hosts with a network secret resolve here through
// /etc/hosts; it terminates TLS with a leaf cert from this sandbox's CA, then forwards each HTTP/1.1 request to the
// Worker's /net route with the capability token in a header. Nothing secret is stored here.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const DIR = process.env.CLOUD_SWE_DIR ?? '/etc/cloud-swe';
const PORT = Number(process.env.EGRESS_PORT ?? 443);
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host',
  'proxy-authorization',
]);

let config;
let mtime = 0;

function load() {
  const stat = fs.statSync(`${DIR}/egress.json`);

  if (stat.mtimeMs !== mtime) {
    config = JSON.parse(fs.readFileSync(`${DIR}/egress.json`, 'utf8'));
    mtime = stat.mtimeMs;
  }

  return config;
}

const contexts = new Map();

function contextFor(host) {
  if (!load().hosts.includes(host)) return null;
  const cached = contexts.get(host);

  if (cached) return cached;
  const base = `${DIR}/leaf-${host}`;

  fs.writeFileSync(
    `${base}.ext`,
    `subjectAltName=DNS:${host}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n` +
      `extendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`,
  );
  execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', `${base}.key`, '-subj', `/CN=${host}`, '-out', `${base}.csr`], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', `${base}.csr`, '-CA', `${DIR}/ca.crt`, '-CAkey', `${DIR}/ca.key`,
    '-CAcreateserial', '-days', '30', '-sha256', '-extfile', `${base}.ext`, '-out', `${base}.crt`], { stdio: 'ignore' });

  const context = tls.createSecureContext({
    key: fs.readFileSync(`${base}.key`),
    cert: fs.readFileSync(`${base}.crt`),
  });

  contexts.set(host, context);

  return context;
}

function handle(request, response) {
  const host = request.socket.servername;
  const { workerUrl, token } = load();
  const nonce = crypto.randomBytes(16);
  const headers = { 'x-spike-token': token, 'x-spike-nonce': nonce.toString('hex') };

  for (const [name, value] of Object.entries(request.headers)) if (!HOP.has(name)) headers[name] = value;
  headers['accept-encoding'] = 'identity';

  const upstream = https.request(`${workerUrl}/net/${host}${request.url}`, { method: request.method, headers }, (reply) => {
    const out = {};

    for (const [name, value] of Object.entries(reply.headers)) if (!HOP.has(name)) out[name] = value;
    response.writeHead(reply.statusCode ?? 502, out);
    // A broken upstream must reach the client as a broken response, never a clean end. The Worker appends the nonce
    // and a status byte; anything else at the end (or nothing) means the body was cut.
    const broken = (why) => { console.error(new Date().toISOString(), 'broken:', why, host, request.url.slice(0, 60)); response.destroy(); };
    reply.on('aborted', () => broken('worker connection aborted'));
    reply.on('error', (e) => broken('worker connection error ' + e.message));
    // Bodiless replies carry no trailer.
    if (request.method === 'HEAD' || reply.statusCode === 204 || reply.statusCode === 304) return reply.pipe(response);
    let held = Buffer.alloc(0);
    reply.on('data', (chunk) => {
      held = Buffer.concat([held, chunk]);

      if (held.length > 17) {
        response.write(held.subarray(0, held.length - 17));
        held = held.subarray(held.length - 17);
      }
    });
    reply.on('end', () => (held.length === 17 && held.subarray(0, 16).equals(nonce) && held[16] === 0 ? response.end() : broken(held.length === 17 ? 'trailer says upstream broke' : 'trailer missing')));
  });
  upstream.on('error', (error) => {
    console.error(new Date().toISOString(), 'worker request error:', error.message, host);
    // Mid-response, only a broken connection is truthful; a clean end would pass a cut body off as complete.
    if (response.headersSent) return response.destroy();
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end('cloud-swe egress: ' + error.message + '\n');
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}

const server = http.createServer(handle);

// WebSockets: forward the upgrade to the Worker and splice the two sockets once both sides switch protocols.
server.on('upgrade', (request, socket, head) => {
  const host = request.socket.servername;
  const { workerUrl, token } = load();
  const headers = { 'x-spike-token': token, connection: 'Upgrade', upgrade: 'websocket' };

  for (const [name, value] of Object.entries(request.headers)) if (!HOP.has(name)) headers[name] = value;
  const upstream = https.request(`${workerUrl}/net/${host}${request.url}`, { headers });

  upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols'];

    for (let i = 0; i < reply.rawHeaders.length; i += 2) lines.push(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');

    if (upstreamHead.length) socket.write(upstreamHead);

    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
  });
  upstream.on('response', (reply) => {
    socket.end(`HTTP/1.1 ${reply.statusCode} Upgrade Refused\r\nconnection: close\r\n\r\n`);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

const listener = () =>
  tls.createServer(
    {
      ALPNProtocols: ['http/1.1'],
      SNICallback(name, callback) {
        try {
          const context = contextFor(name.toLowerCase());

          callback(context ? null : new Error('not a network-secret host'), context ?? undefined);
        } catch (error) {
          callback(error);
        }
      },
    },
    (socket) => server.emit('connection', socket),
  );

listener().listen(PORT, '127.0.0.1');
listener()
  .on('error', (error) => console.error('ipv6 listener:', error.message))
  .listen(PORT, '::1');
fs.writeFileSync(`${DIR}/daemon.pid`, String(process.pid));
console.log('egress daemon listening');
