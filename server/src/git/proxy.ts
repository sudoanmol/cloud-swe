/**
 * Path: server/src/git/proxy.ts
 * Used by: server/src/index.ts.
 * Purpose: Streams git smart-HTTP between a sandbox and github.com, adding the installation token; mounted before bearer auth because sandboxes use a capability token.
 */

import { setTimeout } from 'node:timers/promises';

import type { Hono } from 'hono';

import { credentialsStub, type Env, threadStub } from '../env.ts';

// GitHub refuses a share of the Worker's requests with a 429 for short windows, before acting on them.
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

const RETRY_BODY_LIMIT = 32 * 1024 * 1024;

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/** A stream of the chunks already read, then the rest of `reader`. */
function prepend(chunks: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const next = await reader.read();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * Holds a body in memory so a refused request can be sent again. A larger one stays a stream and gets one try.
 * ponytail: a push over the limit fails on a 429; retrying it would need the body stored somewhere durable.
 */
async function replayable(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (size <= RETRY_BODY_LIMIT) {
    const next = await reader.read();

    if (next.done) return concat(chunks);
    chunks.push(next.value);
    size += next.value.length;
  }

  return prepend(chunks, reader);
}

const PATH =
  /^\/git\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const text = (status: number, body: string) =>
  new Response(body + '\n', { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

function bearer(request: Request): string | undefined {
  return /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
}

function upstreamHeaders(request: Request, token: string | undefined): Headers {
  const headers = new Headers({ 'User-Agent': 'git/cloud-swe-proxy', 'Accept-Encoding': 'identity' });

  for (const name of ['Content-Type', 'Accept', 'Git-Protocol', 'Content-Encoding']) {
    const value = request.headers.get(name);

    if (value) headers.set(name, value);
  }

  if (token) headers.set('Authorization', 'Basic ' + btoa('x-access-token:' + token));

  return headers;
}

// Cache headers are kept; anything that could carry credentials or redirects is dropped.
function relay(upstream: Response): Response {
  const headers = new Headers({ 'Cache-Control': 'no-cache' });
  const type = upstream.headers.get('Content-Type');

  if (type) headers.set('Content-Type', type);

  return new Response(upstream.body, { status: upstream.status, headers });
}

/** An authorized request, with what forwarding it upstream needs. */
type GitRequest = { raw: Request; url: string; token: string | undefined };

const send = (git: GitRequest, body: BodyInit | null) =>
  fetch(git.url, {
    method: git.raw.method,
    headers: upstreamHeaders(git.raw, git.token),
    body,
    redirect: 'manual',
  });

/** The upstream response, or null when GitHub redirected. */
async function forward(git: GitRequest, stream: ReadableStream<Uint8Array> | null): Promise<Response | null> {
  const body = await replayable(stream);
  let upstream = await send(git, body);

  // A 429 means GitHub didn't act on the request, so sending it again can't apply anything twice.
  for (const delay of body instanceof ReadableStream ? [] : RETRY_DELAYS_MS) {
    if (upstream.status !== 429) break;
    await upstream.body?.cancel();
    await setTimeout(delay);
    upstream = await send(git, body);
  }

  // Any redirect would leave github.com/<owner>/<repo>.git; refuse it instead of following.
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();

    return null;
  }

  return upstream;
}

function respond(upstream: Response | null): Response {
  if (!upstream) return text(502, 'Upstream refused or redirected the request');

  return upstream.status === 429
    ? text(429, 'GitHub is rate limiting this request; try again shortly')
    : relay(upstream);
}

async function handle(env: Env, raw: Request, path: string, service: string | undefined): Promise<Response> {
  const [, sessionId, owner, repo, operation] = PATH.exec(path) ?? [];

  if (!sessionId || !owner || !repo || !operation) return text(404, 'Not found');

  const allowed =
    operation === 'info/refs'
      ? raw.method === 'GET' && (service === 'git-upload-pack' || service === 'git-receive-pack')
      : raw.method === 'POST';

  // A mismatched operation (e.g. upload-pack POST to a receive-pack service) is simply not forwarded.
  if (!allowed) return text(405, 'Method not allowed');

  const token = bearer(raw);

  if (!token) return text(401, 'Missing Git access token');

  if (!(await threadStub(env, sessionId).authorizeGit(token)))
    return text(401, 'Git access token is invalid or expired');
  let installationToken: string | undefined;

  try {
    installationToken = await credentialsStub(env).githubToken(owner, repo);
  } catch {
    return text(502, 'Could not get a GitHub access token');
  }

  const git: GitRequest = {
    raw,
    url: `https://github.com/${owner}/${repo}.git/${operation}${operation === 'info/refs' ? '?service=' + service : ''}`,
    token: installationToken,
  };

  return respond(await forward(git, raw.method === 'POST' ? raw.body : null));
}

export function gitProxyRoutes(app: Hono<{ Bindings: Env }>) {
  app.all('/git/*', (c) => handle(c.env, c.req.raw, c.req.path, c.req.query('service')));
}
