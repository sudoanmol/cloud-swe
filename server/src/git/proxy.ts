/**
 * Path: server/src/git/proxy.ts
 * Used by: server/src/index.ts.
 * Purpose: Streams git smart-HTTP between a sandbox and github.com, adding the installation token and enforcing the push policy; mounted before bearer auth because sandboxes use a capability token. Restores the old tip after a forced update.
 */

import { setTimeout } from 'node:timers/promises';

import type { Hono } from 'hono';
import { z } from 'zod';

import { credentialsStub, type Env, threadStub } from '../env.ts';
import { githubJson, readRef, writeRef } from '../github.ts';
import {
  checkPush,
  concat,
  isZero,
  prepend,
  type PushCommand,
  type PushRequest,
  readCommands,
  rejectionReport,
} from './push.ts';

const FORCE_REASON = 'force push requires approval: use git_request_ref_update';

// GitHub refuses a share of the Worker's requests with a 429 for short windows, before acting on them.
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

const GitHubCompare = z.object({ status: z.string() });

const RETRY_BODY_LIMIT = 32 * 1024 * 1024;

/**
 * Holds a body in memory so a refused request can be sent again. A larger one stays a stream and gets one try.
 * ponytail: a push over the limit fails on a 429; retrying it would need the body stored somewhere durable.
 */
async function replayable(
  body: ReadableStream<Uint8Array> | null,
): Promise<ReturnType<typeof concat> | ReadableStream<Uint8Array> | null> {
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

/**
 * ponytail: the update is forwarded first and checked afterwards, so the session branch briefly shows the forced
 * commit before it is restored (ceiling). Parsing the pack to check ancestry before forwarding is the upgrade path.
 * The rejected commit stays on GitHub, which is what the approval path needs.
 */
async function wasFastForward(token: string | undefined, slug: string, command: PushCommand): Promise<boolean> {
  try {
    const { status } = await githubJson(
      GitHubCompare,
      token,
      'GET',
      `/repos/${slug}/compare/${command.old}...${command.new}`,
    );

    return status === 'ahead' || status === 'identical';
  } catch {
    // Unverifiable counts as forced: restoring is safe, trusting is not.
    return false;
  }
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
function relay(upstream: Response, body: BodyInit | null): Response {
  const headers = new Headers({ 'Cache-Control': 'no-cache' });
  const type = upstream.headers.get('Content-Type');

  if (type) headers.set('Content-Type', type);

  return new Response(body, { status: upstream.status, headers });
}

/** An authorized request, with what forwarding it upstream needs. */
type GitRequest = {
  env: Env;
  raw: Request;
  thread: ReturnType<typeof threadStub>;
  sessionId: string;
  owner: string;
  repo: string;
  url: string;
  token: string | undefined;
};

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

const unreachable = () => text(502, 'Upstream refused or redirected the request');

const relayOrBusy = (upstream: Response) =>
  upstream.status === 429
    ? text(429, 'GitHub is rate limiting this request; try again shortly')
    : relay(upstream, upstream.body);

const respond = (upstream: Response | null) => (upstream ? relayOrBusy(upstream) : unreachable());

function reject(request: PushRequest, ref: string, reason: string): Response {
  return request.capabilities.some((capability) => capability.startsWith('report-status'))
    ? new Response(rejectionReport(ref, reason, request.capabilities), {
        headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' },
      })
    : text(403, reason);
}

/**
 * After GitHub accepted an update: undefined when nothing forced landed, otherwise whether the branch was put back on
 * its old tip.
 */
async function restoreForced(git: GitRequest, command: PushCommand): Promise<boolean | undefined> {
  // A large push can outlast the token it started with, so the checks ask for a current one.
  const current = await credentialsStub(git.env)
    .githubToken(git.owner, git.repo)
    .catch(() => git.token);

  const slug = `${git.owner}/${git.repo}`;

  // GitHub reports a rejected push inside a 200. If the branch isn't at the new tip, the push changed nothing and
  // `old` is only the client's claim, so there is nothing to restore. A failed read counts as not applied too:
  // restoring from it could rewrite the branch.
  const applied = await readRef(current, slug, command.ref).then(
    (sha) => sha === command.new,
    () => false,
  );

  if (!applied || (await wasFastForward(current, slug, command))) return undefined;

  return writeRef(current, slug, command.ref, command.new, command.old, true).then(
    (sha) => sha === command.old,
    () => false,
  );
}

async function receivePack(git: GitRequest, body: ReadableStream<Uint8Array>): Promise<Response> {
  if (git.raw.headers.get('Content-Encoding')) return text(415, 'Compressed pushes are not supported');

  let commands: Awaited<ReturnType<typeof readCommands>>;

  try {
    commands = await readCommands(body);
  } catch {
    return text(400, 'Invalid push request');
  }

  const { request, stream } = commands;

  // Git probes a large push with a bare flush first. With no commands nothing is updated, so it goes upstream.
  if (request.commands.length === 0 && !request.unsupported) return respond(await forward(git, stream));

  const decision = checkPush(request, git.sessionId);

  if (!decision.ok) {
    await stream.cancel();
    const { blocked } = decision;

    const reason = blocked
      ? await git.thread.requestBlockedPush(`https://github.com/${git.owner}/${git.repo}`, blocked)
      : decision.reason;

    return reject(request, request.commands[0]?.ref ?? 'refs/unknown', reason);
  }

  const { command } = decision;
  const upstream = await forward(git, stream);

  if (!upstream) return unreachable();

  // Creating the branch cannot overwrite anything. Every accepted update is checked for fast-forward after the
  // fact, whatever the report says: a client that skips report-status gets no report to read.
  if (!upstream.ok || isZero(command.old) || command.old === command.new) return relayOrBusy(upstream);

  const report = new Uint8Array(await upstream.arrayBuffer());
  const restored = await restoreForced(git, command);

  if (restored === undefined) return relay(upstream, report);

  return reject(
    request,
    command.ref,
    restored ? FORCE_REASON : `${FORCE_REASON} (the forced update could not be reverted; tell the user)`,
  );
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

  const thread = threadStub(env, sessionId);
  const authorization = await thread.authorizeGit(token, owner, repo);

  if (authorization === 'unauthorized') return text(401, 'Git access token is invalid or expired');

  if (authorization === 'forbidden') return text(403, 'Repository is not registered for this session');

  if (authorization === 'unavailable') return text(503, 'Could not check the sandbox; try again');
  let installationToken: string | undefined;

  try {
    installationToken = await credentialsStub(env).githubToken(owner, repo);
  } catch {
    return text(502, 'Could not get a GitHub access token');
  }

  const git: GitRequest = {
    env,
    raw,
    thread,
    sessionId,
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}.git/${operation}${operation === 'info/refs' ? '?service=' + service : ''}`,
    token: installationToken,
  };

  if (operation !== 'git-receive-pack' || !raw.body) {
    return respond(await forward(git, raw.method === 'POST' ? raw.body : null));
  }

  return receivePack(git, raw.body);
}

export function gitProxyRoutes(app: Hono<{ Bindings: Env }>) {
  app.all('/git/*', (c) => handle(c.env, c.req.raw, c.req.path, c.req.query('service')));
}
