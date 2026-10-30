import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { type Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';
import { z } from 'zod';

const run = promisify(execFile);

const identity = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

type Pull = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  sha: string;
  base: string;
};

// Every field the fake reads from a request body; anything else is ignored.
const Body = z.object({
  title: z.string().optional(),
  head: z.string().optional(),
  base: z.string().optional(),
  state: z.enum(['open', 'closed']).optional(),
  body: z.string().optional(),
  ref: z.string().optional(),
  sha: z.string().optional(),
  force: z.boolean().optional(),
});

type Body = z.infer<typeof Body>;

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

const json = (body: Json, status = 200) =>
  new WorkerResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const notFound = () => json({ message: 'Not Found' }, 404);

/**
 * A fake api.github.com and github.com backed by real bare repositories, so refs, ancestry and the smart-HTTP
 * protocol (through `git http-backend`) are real git, and only GitHub's REST surface is imitated.
 */
export class FakeGitHub {
  readonly pat = 'ghp_fake_personal_access_token_0123456789';
  readonly calls: string[] = [];
  readonly gitCalls: string[] = [];
  readonly gitAuth: (string | null)[] = [];
  readonly pulls = new Map<number, Pull>();
  readonly comments: { number: number; body: string }[] = [];
  readonly privateRepos = new Set<string>();
  // Applies the matching "METHOD path" call, then answers 502 once, as if the response were lost.
  readonly lose: { pattern: RegExp; used: boolean }[] = [];
  redirectGit = false;
  emailsForbidden = false;
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create() {
    return new FakeGitHub(await mkdtemp(join(tmpdir(), 'fake-github-')));
  }

  private bare(owner: string, repo: string) {
    return join(this.root, owner, repo + '.git');
  }

  private git(owner: string, repo: string, ...args: string[]) {
    return run('git', ['-C', this.bare(owner, repo), ...args], { env: { ...process.env, ...identity } });
  }

  private async succeeds(owner: string, repo: string, ...args: string[]) {
    return this.git(owner, repo, ...args).then(
      () => true,
      () => false,
    );
  }

  /** A bare repo whose `main` has one commit. */
  async repo(owner: string, repo: string, options: { private?: boolean } = {}) {
    await mkdir(join(this.root, owner), { recursive: true });
    await run('git', ['init', '--bare', '-b', 'main', this.bare(owner, repo)]);
    await this.advance(owner, repo, 'main', 'README', 'hello\n');

    if (options.private) this.privateRepos.add(`${owner}/${repo}`);
  }

  /** Adds a commit on `branch` (created from main when new) and returns its SHA. */
  async advance(owner: string, repo: string, branch: string, file: string, content: string) {
    const work = await mkdtemp(join(tmpdir(), 'fake-work-'));
    const env = { ...process.env, ...identity };
    await run('git', ['init', '-b', branch, work], { env });
    const base = (await this.sha(owner, repo, branch)) ?? (await this.sha(owner, repo, 'main'));

    if (base) {
      await run('git', ['-C', work, 'fetch', this.bare(owner, repo), base], { env });
      await run('git', ['-C', work, 'reset', '--hard', 'FETCH_HEAD'], { env });
    }

    await run('bash', ['-c', 'printf %s "$1" > "$2"', 'write', content, join(work, file)]);
    await run('git', ['-C', work, 'add', file], { env });
    await run('git', ['-C', work, 'commit', '-m', `change ${file}`], { env });
    await run('git', ['-C', work, 'push', '--force', this.bare(owner, repo), `HEAD:refs/heads/${branch}`], { env });

    return (await run('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  }

  async sha(owner: string, repo: string, ref: string): Promise<string | undefined> {
    try {
      return (await this.git(owner, repo, 'rev-parse', '--verify', '-q', `refs/heads/${ref}`)).stdout.trim();
    } catch {
      return undefined;
    }
  }

  hasCommit(owner: string, repo: string, sha: string) {
    return this.succeeds(owner, repo, 'cat-file', '-e', sha + '^{commit}');
  }

  count(pattern: RegExp) {
    return this.calls.filter((call) => pattern.test(call)).length;
  }

  handle(request: WorkerRequest): Promise<WorkerResponse> {
    const url = new URL(request.url);

    return url.hostname === 'github.com' ? this.smartHttp(request, url) : this.api(request, url);
  }

  private async api(request: WorkerRequest, url: URL): Promise<WorkerResponse> {
    this.calls.push(`${request.method} ${url.pathname}${url.search}`);

    if (request.headers.get('Authorization') !== `Bearer ${this.pat}`) return json({ message: 'Bad credentials' }, 401);

    const body = request.method === 'GET' ? {} : Body.parse(await request.json().catch(() => ({})));
    const response = await this.route(request.method, url, body);
    const lost = this.lose.find((entry) => !entry.used && entry.pattern.test(`${request.method} ${url.pathname}`));

    if (!lost) return response;
    lost.used = true;

    return new WorkerResponse('lost', { status: 502 });
  }

  private async route(method: string, url: URL, body: Body): Promise<WorkerResponse> {
    const path = url.pathname;

    if (path === '/user') return json({ id: 42, login: 'octo', name: 'Octo Cat', email: null });

    if (path === '/user/emails') {
      return this.emailsForbidden
        ? json({ message: 'forbidden' }, 403)
        : json([{ email: 'octo@example.com', primary: true, verified: true }]);
    }

    const repo = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);

    if (!repo?.[1] || !repo[2] || !repo[3]) return notFound();
    const [, owner, name, rest] = repo;

    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);

    if (method === 'GET' && ref?.[1]) {
      const sha = await this.sha(owner, name, ref[1]);

      return sha ? json({ object: { sha } }) : notFound();
    }

    const commit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);

    if (method === 'GET' && commit?.[1]) {
      return (await this.hasCommit(owner, name, commit[1])) ? json({ sha: commit[1] }) : notFound();
    }

    if (method === 'POST' && rest === '/git/refs') {
      const created = /^refs\/heads\/(.+)$/.exec(body.ref ?? '');
      const sha = body.sha ?? '';

      if (!created?.[1] || (await this.sha(owner, name, created[1])) || !(await this.hasCommit(owner, name, sha))) {
        return json({ message: 'Unprocessable' }, 422);
      }

      await this.git(owner, name, 'update-ref', `refs/heads/${created[1]}`, sha);

      return json({ object: { sha } }, 201);
    }

    const patch = /^\/git\/refs\/heads\/(.+)$/.exec(rest);

    if (method === 'PATCH' && patch?.[1]) {
      const current = await this.sha(owner, name, patch[1]);
      const sha = body.sha ?? '';

      if (!current) return notFound();
      const fastForward = await this.succeeds(owner, name, 'merge-base', '--is-ancestor', current, sha);

      if (!(await this.hasCommit(owner, name, sha)) || (!body.force && !fastForward)) {
        return json({ message: 'Update is not a fast forward' }, 422);
      }

      await this.git(owner, name, 'update-ref', `refs/heads/${patch[1]}`, sha);

      return json({ object: { sha } });
    }

    const compare = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest);

    if (method === 'GET' && compare?.[1] && compare[2]) {
      const [, a, b] = compare;

      if (!(await this.hasCommit(owner, name, a)) || !(await this.hasCommit(owner, name, b))) return notFound();

      if (a === b) return json({ status: 'identical' });

      if (await this.succeeds(owner, name, 'merge-base', '--is-ancestor', a, b)) return json({ status: 'ahead' });

      return json({
        status: (await this.succeeds(owner, name, 'merge-base', '--is-ancestor', b, a)) ? 'behind' : 'diverged',
      });
    }

    return this.pullApi(method, rest, url, body, `${owner}/${name}`);
  }

  private pullApi(method: string, rest: string, url: URL, body: Body, repo: string): WorkerResponse {
    const pull = (value: Pull) => ({
      number: value.number,
      html_url: `https://github.com/${repo}/pull/${value.number}`,
      title: value.title,
      state: value.state,
      merged: value.merged,
      body: '',
      head: { sha: value.sha, ref: value.head },
      base: { ref: value.base },
    });

    if (rest === '/pulls' && method === 'GET') {
      const head = url.searchParams.get('head')?.split(':')[1];
      const base = url.searchParams.get('base');

      return json(
        this.pulls
          .values()
          .filter((value) => value.state === 'open' && (!head || value.head === head) && (!base || value.base === base))
          .map(pull)
          .toArray(),
      );
    }

    if (rest === '/pulls' && method === 'POST') {
      const created: Pull = {
        number: this.pulls.size + 1,
        title: body.title ?? '',
        state: 'open',
        merged: false,
        head: body.head ?? '',
        sha: 'a'.repeat(40),
        base: body.base ?? '',
      };

      this.pulls.set(created.number, created);

      return json(pull(created), 201);
    }

    const single = /^\/pulls\/(\d+)(\/merge)?$/.exec(rest);
    const found = single?.[1] ? this.pulls.get(Number(single[1])) : undefined;

    if (single && !found) return notFound();

    if (found && !single?.[2]) {
      if (method === 'PATCH') {
        found.state = body.state ?? found.state;
        found.title = body.title ?? found.title;
      }

      return json(pull(found));
    }

    if (found && single?.[2] && method === 'PUT') {
      if (found.state !== 'open' || body.sha !== found.sha) return json({ message: 'Head branch was modified' }, 409);
      found.merged = true;
      found.state = 'closed';

      return json({ merged: true, sha: 'b'.repeat(40) });
    }

    const comments = /^\/issues\/(\d+)\/comments$/.exec(rest);

    if (comments?.[1] && method === 'GET') {
      return json(
        this.comments.flatMap((comment, id) =>
          comment.number === Number(comments[1])
            ? [{ id, body: comment.body, html_url: `https://github.com/${repo}/pull/1#c${id}` }]
            : [],
        ),
      );
    }

    if (comments?.[1] && method === 'POST') {
      this.comments.push({ number: Number(comments[1]), body: body.body ?? '' });

      return json({ id: this.comments.length, body: body.body, html_url: `https://github.com/${repo}/pull/1#c` }, 201);
    }

    return notFound();
  }

  private async smartHttp(request: WorkerRequest, url: URL): Promise<WorkerResponse> {
    this.gitCalls.push(`${request.method} ${url.pathname}${url.search}`);
    this.gitAuth.push(request.headers.get('Authorization'));

    if (this.redirectGit) {
      return new WorkerResponse(null, { status: 302, headers: { Location: 'https://evil.example/x' } });
    }

    const [, owner, repo] = /^\/([^/]+)\/([^/]+)\.git\//.exec(url.pathname) ?? [];
    const expected = 'Basic ' + Buffer.from(`x-access-token:${this.pat}`).toString('base64');

    if (
      owner &&
      repo &&
      this.privateRepos.has(`${owner}/${repo}`) &&
      request.headers.get('Authorization') !== expected
    ) {
      return new WorkerResponse('auth required', { status: 401 });
    }

    const body = Buffer.from(await request.arrayBuffer());

    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        HOME: this.root,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers.get('Content-Type') ?? '',
        CONTENT_LENGTH: String(body.length),
        REMOTE_USER: 'fixture',
        REMOTE_ADDR: '127.0.0.1',
        HTTP_GIT_PROTOCOL: request.headers.get('Git-Protocol') ?? '',
        ...identity,
      },
    });

    child.stdin.end(body);
    const chunks: Buffer[] = [];

    for await (const chunk of child.stdout) chunks.push(Buffer.from(chunk));
    const output = Buffer.concat(chunks);
    const split = output.indexOf('\r\n\r\n');
    const headers: Record<string, string> = {};
    let status = 200;

    for (const line of output.subarray(0, split).toString().split('\r\n')) {
      const [name, ...value] = line.split(': ');

      if (name === 'Status') status = Number.parseInt(value.join(': '), 10);
      else if (name) headers[name] = value.join(': ');
    }

    return new WorkerResponse(output.subarray(split + 4), { status, headers });
  }
}
