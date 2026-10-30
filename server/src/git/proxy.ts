/**
 * Path: server/src/git/proxy.ts
 * Used by: server/src/index.ts (mounted before bearer auth: sandboxes authenticate with a capability token).
 * Purpose: Streams git smart-HTTP between a sandbox and github.com, adding the PAT and enforcing the push policy. Nothing else is reachable through it.
 */
import type { Hono } from 'hono';

import type { Env } from '../env';
import { FORCE_REASON, restoreRef, wasFastForward } from './force-push';
import { concat, parsePushRequest, rejectionReport, type PushRequest } from './pktline.ts';
import { checkPush } from './receive-pack.ts';

const PATH =
  /^\/git\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

// The command list is tiny; refuse anything that would make us buffer a pack.
const MAX_COMMANDS_BYTES = 64 * 1024;

const text = (status: number, body: string) =>
  new Response(body + '\n', { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

function bearer(request: Request): string | undefined {
  return /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
}

/** Reads from `body` until the command list is complete; returns it with every byte read so far. */
async function readCommands(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let buffered = new Uint8Array(0);
  let request: PushRequest | undefined;

  while (!request) {
    const chunk = await reader.read();

    if (chunk.done) throw new Error('Truncated push request');
    buffered = concat([buffered, chunk.value]);

    if (buffered.length > MAX_COMMANDS_BYTES) throw new Error('Push command list too large');
    request = parsePushRequest(buffered);
  }

  // Replays what was read, then the untouched remainder of the pack.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buffered);
    },
    async pull(controller) {
      const next = await reader.read();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });

  return { request, stream };
}

function upstreamHeaders(request: Request, pat: string | undefined): Headers {
  const headers = new Headers({ 'User-Agent': 'git/cloud-swe-proxy', 'Accept-Encoding': 'identity' });

  for (const name of ['Content-Type', 'Accept', 'Git-Protocol', 'Content-Encoding']) {
    const value = request.headers.get(name);

    if (value) headers.set(name, value);
  }

  if (pat) headers.set('Authorization', 'Basic ' + btoa('x-access-token:' + pat));

  return headers;
}

// Cache headers are kept; anything that could carry credentials or redirects is dropped.
function relay(upstream: Response, body: BodyInit | null): Response {
  const headers = new Headers({ 'Cache-Control': 'no-cache' });
  const type = upstream.headers.get('Content-Type');

  if (type) headers.set('Content-Type', type);

  return new Response(body, { status: upstream.status, headers });
}

export function gitProxyRoutes(app: Hono<{ Bindings: Env }>) {
  app.all('/git/*', async (c) => {
    const match = PATH.exec(c.req.path);

    if (!match) return text(404, 'Not found');
    const [, sessionId, owner, repo, operation] = match;

    if (!sessionId || !owner || !repo || !operation) return text(404, 'Not found');

    const service = c.req.query('service');

    const allowed =
      operation === 'info/refs'
        ? c.req.method === 'GET' && (service === 'git-upload-pack' || service === 'git-receive-pack')
        : c.req.method === 'POST';

    // A mismatched operation (e.g. upload-pack POST to a receive-pack service) is simply not forwarded.
    if (!allowed) return text(405, 'Method not allowed');

    const token = bearer(c.req.raw);

    if (!token) return text(401, 'Missing Git access token');

    const thread = c.env.THREADS.get(c.env.THREADS.idFromName(sessionId));
    const authorization = await thread.authorizeGit(token, owner, repo);

    if (authorization === 'unauthorized') return text(401, 'Git access token is invalid or expired');

    if (authorization === 'forbidden') return text(403, 'Repository is not registered for this session');

    const credentials = c.env.CREDENTIALS.get(c.env.CREDENTIALS.idFromName('personal'));
    const pat = await credentials.githubToken();
    const url = `https://github.com/${owner}/${repo}.git/${operation}${operation === 'info/refs' ? '?service=' + service : ''}`;

    const forward = async (body: BodyInit | null) => {
      const upstream = await fetch(url, {
        method: c.req.method,
        headers: upstreamHeaders(c.req.raw, pat),
        body,
        redirect: 'manual',
      });

      // Any redirect would leave github.com/<owner>/<repo>.git; refuse it instead of following.
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();

        return null;
      }

      return upstream;
    };

    const unreachable = () => text(502, 'Upstream refused or redirected the request');

    if (operation !== 'git-receive-pack' || !c.req.raw.body) {
      const upstream = await forward(c.req.method === 'POST' ? c.req.raw.body : null);

      return upstream ? relay(upstream, upstream.body) : unreachable();
    }

    if (c.req.header('Content-Encoding')) return text(415, 'Compressed pushes are not supported');

    let commands: Awaited<ReturnType<typeof readCommands>>;

    try {
      commands = await readCommands(c.req.raw.body);
    } catch {
      return text(400, 'Invalid push request');
    }

    const { request, stream } = commands;
    const decision = checkPush(request, sessionId);

    const reject = (ref: string, reason: string) =>
      request.capabilities.some((capability) => capability.startsWith('report-status'))
        ? new Response(rejectionReport(ref, reason, request.capabilities), {
            headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' },
          })
        : text(403, reason);

    if (!decision.ok) {
      await stream.cancel();

      return reject(request.commands[0]?.ref ?? 'refs/unknown', decision.reason);
    }

    const { command } = decision;
    const upstream = await forward(stream);

    if (!upstream) return unreachable();

    // Creating the branch cannot overwrite anything. Updates are checked for fast-forward after the fact.
    if (/^0+$/.test(command.old) || command.old === command.new) return relay(upstream, upstream.body);

    const report = new Uint8Array(await upstream.arrayBuffer());

    if (
      !upstream.ok ||
      report.length > MAX_COMMANDS_BYTES ||
      !new TextDecoder().decode(report).includes(`ok ${command.ref}`)
    ) {
      return relay(upstream, report);
    }

    if (await wasFastForward(pat, owner, repo, command)) return relay(upstream, report);

    const restored = await restoreRef(pat, owner, repo, command);

    return reject(
      command.ref,
      restored ? FORCE_REASON : `${FORCE_REASON} (the forced update could not be reverted; tell the user)`,
    );
  });
}
