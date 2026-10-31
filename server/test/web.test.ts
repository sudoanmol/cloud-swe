/**
 * Path: server/test/web.test.ts
 * Used by: pnpm test.
 * Purpose: The web tools: Firecrawl requests, URL safety, fixed failure messages, and saving a cut output whole in the sandbox.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FileBytes } from '@cloud-swe/protocol/tools';
import type { JsonValue } from '@earendil-works/chord';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { rejectUrl } from '../src/tools/firecrawl.ts';
import { runFetch, runSearch, webTools, withFullOutput } from '../src/tools/web.ts';
import { lifecycleRig } from './lifecycle-rig.ts';

const KEY = 'fc-secret-key';
const raw = 'raw-upstream-text-never-echo';
const none = async () => [];

type Call = { url: string; auth: string | null; body: Record<string, JsonValue> };

function upstream(respond: (call: Call) => Response) {
  const calls: Call[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      auth: new Headers(init?.headers).get('Authorization'),
      body: JSON.parse(String(init?.body)),
    };

    calls.push(call);

    return respond(call);
  };

  return { calls, fetcher };
}

test('web tools exist only with a Firecrawl key, and both may safely replay', () => {
  assert.deepEqual(webTools(undefined, none), []);
  assert.deepEqual(webTools('', none), []);
  assert.deepEqual(
    webTools(KEY, none).map((tool) => [tool.name, tool.replay]),
    [
      ['web_search', 'safe'],
      ['web_fetch', 'safe'],
    ],
  );
});

test('search sends the key and filters, merges web and news, and clamps the limit', async () => {
  const { calls, fetcher } = upstream(() =>
    Response.json({
      success: true,
      data: {
        web: [{ title: 'A', url: 'https://a.test/', description: 'about **a**', extra: 'ignored' }],
        news: [{ title: 'N', url: 'https://n.test/', snippet: 'news', date: '1 day ago' }],
      },
    }),
  );

  const outcome = await runSearch(
    KEY,
    {
      query: 'pi durable',
      limit: 99,
      sources: ['web', 'news'],
      categories: ['developer'],
      recency: 'week',
      includeDomains: ['a.test'],
    },
    undefined,
    fetcher,
  );

  assert.equal(outcome.isError, false);
  assert.equal(calls[0]?.url, 'https://api.firecrawl.dev/v2/search');
  assert.equal(calls[0]?.auth, `Bearer ${KEY}`);

  assert.deepEqual(
    { ...calls[0]?.body, timeout: undefined },
    {
      query: 'pi durable',
      limit: 10,
      sources: [{ type: 'web' }, { type: 'news' }],
      categories: [{ type: 'developer' }],
      tbs: 'qdr:w',
      includeDomains: ['a.test'],
      timeout: undefined,
    },
  );

  assert.match(outcome.text, /1\. A\n {3}https:\/\/a\.test\/\n {3}about \*\*a\*\*/);
  assert.match(outcome.text, /2\. N/);
  assert.equal(outcome.text.includes(KEY), false);

  assert.deepEqual(outcome.structured, {
    results: [
      { title: 'A', url: 'https://a.test/', snippet: 'about **a**' },
      { title: 'N', url: 'https://n.test/', snippet: 'news', date: '1 day ago' },
    ],
  });
});

test('search defaults to five web results, scrapes only on request and handles no results', async () => {
  const { calls, fetcher } = upstream(() => Response.json({ success: true, data: { web: [] } }));
  const empty = await runSearch(KEY, { query: 'nothing' }, undefined, fetcher);

  assert.equal(empty.isError, false);
  assert.match(empty.text, /No results/);
  assert.deepEqual(
    [calls[0]?.body.limit, calls[0]?.body.sources, calls[0]?.body.scrapeOptions],
    [5, [{ type: 'web' }], undefined],
  );

  await runSearch(KEY, { query: 'x', limit: 0, scrape: true }, undefined, fetcher);
  assert.equal(calls[1]?.body.limit, 1);
  assert.deepEqual(calls[1]?.body.scrapeOptions, { formats: ['markdown'], onlyMainContent: true });
});

test('upstream failures become fixed messages that never echo upstream text or the key', async () => {
  const expected: [number, RegExp][] = [
    [401, /rejected the server API key/],
    [402, /credits are exhausted/],
    [429, /rate limit/],
    [504, /timed out/],
    [500, /HTTP 500/],
  ];

  for (const [status, message] of expected) {
    const { fetcher } = upstream(() => Response.json({ error: raw + KEY }, { status }));

    for (const outcome of [
      await runSearch(KEY, { query: 'q' }, undefined, fetcher),
      await runFetch(KEY, { urls: ['https://example.com/'] }, undefined, fetcher),
    ]) {
      assert.equal(outcome.isError, true);
      assert.match(outcome.text, message);
      assert.equal(outcome.text.includes(raw) || outcome.text.includes(KEY), false);
    }
  }

  const odd = upstream(() => Response.json({ success: true, data: { web: 'nope' } }));
  assert.match((await runSearch(KEY, { query: 'q' }, undefined, odd.fetcher)).text, /unexpected response/);

  const down: typeof fetch = async () => {
    throw new Error(raw + KEY);
  };

  const failed = await runSearch(KEY, { query: 'q' }, undefined, down);
  assert.equal(failed.isError, true);
  assert.equal(failed.text.includes(raw) || failed.text.includes(KEY), false);
});

test('fetch rejects unsafe URLs before any request, in every spelling of a private host', async () => {
  const rejected = [
    'ftp://example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'http://example.com:8080/',
    'https://example.com:22/',
    'http://localhost/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://db.internal/',
    'http://intranet/',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://0.0.0.0/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[fc00::1]/',
    'http://[fec0::1]/',
    'http://[fed0::1]/',
    'http://[fee0::1]/',
    'http://[fef0::1]/',
    'http://localhost./',
    'http://localhost../',
    'http://app.localhost./',
    'http://printer.local./',
    'http://db.internal./',
    'http://intranet./',
    'http://127.0.0.1./',
  ];

  const { calls, fetcher } = upstream(() => Response.json({ success: true, data: { markdown: 'x' } }));

  for (const url of rejected) {
    assert.notEqual(rejectUrl(url), undefined, url);
    const outcome = await runFetch(KEY, { urls: [url] }, undefined, fetcher);
    assert.equal(outcome.isError, true, url);
  }

  assert.equal(calls.length, 0);

  for (const url of ['https://example.com/', 'http://example.com:80/x', 'https://example.com:443/', 'https://8.8.8.8/'])
    assert.equal(rejectUrl(url), undefined, url);
});

test('fetch returns the answer first, then the page, and passes the question and cache age through', async () => {
  const { calls, fetcher } = upstream(() =>
    Response.json({
      success: true,
      data: {
        markdown: '# Page\n\nBody',
        answer: 'It is 42.',
        metadata: { title: 'The Page', sourceURL: 'https://example.com/doc.pdf' },
      },
    }),
  );

  const outcome = await runFetch(
    KEY,
    { urls: ['https://example.com/doc.pdf'], query: 'What is it?', onlyMainContent: false, maxAge: 0 },
    undefined,
    fetcher,
  );

  assert.equal(calls[0]?.url, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(calls[0]?.auth, `Bearer ${KEY}`);
  assert.deepEqual(
    [calls[0]?.body.formats, calls[0]?.body.onlyMainContent, calls[0]?.body.maxAge],
    [['markdown', { type: 'question', question: 'What is it?' }], false, 0],
  );

  assert.equal(outcome.isError, false);
  assert.match(outcome.text, /^The Page\nhttps:\/\/example\.com\/doc\.pdf\n\nAnswer: It is 42\.\n\n# Page/);
  assert.deepEqual(outcome.structured, {
    pages: [{ url: 'https://example.com/doc.pdf', title: 'The Page', answer: 'It is 42.' }],
    truncated: false,
  });

  await runFetch(KEY, { urls: ['https://example.com/'] }, undefined, fetcher);
  assert.deepEqual(
    [calls[1]?.body.formats, calls[1]?.body.onlyMainContent, 'maxAge' in (calls[1]?.body ?? {})],
    [['markdown'], true, false],
  );
});

test('a large page is cut for the model, with its full text kept for the file', async () => {
  const { fetcher } = upstream(() => Response.json({ success: true, data: { markdown: 'a'.repeat(200_000) } }));
  const outcome = await runFetch(KEY, { urls: ['https://example.com/big'] }, undefined, fetcher);

  assert.equal(outcome.isError, false);
  assert.ok(outcome.text.length < 51_000, String(outcome.text.length));
  assert.ok(outcome.full?.includes('a'.repeat(200_000)));
  assert.deepEqual(outcome.structured, { pages: [{ url: 'https://example.com/big' }], truncated: true });

  const saved = await withFullOutput(outcome, async () => ['/root/.cloud-swe/web/call.md'], 'call');
  assert.match(saved.text, /Output truncated\. Full output \(\d+ characters\)[^]*\/root\/\.cloud-swe\/web\/call\.md$/);
  assert.deepEqual(saved.structured?.fullOutputPaths, ['/root/.cloud-swe/web/call.md']);

  const refused = await withFullOutput(
    outcome,
    async () => {
      throw new Error(raw);
    },
    'call',
  );

  assert.match(refused.text, /could not store the rest/);
  assert.equal(refused.text.includes(raw), false);

  const empty = upstream(() => Response.json({ success: true, data: {} }));
  assert.equal((await runFetch(KEY, { urls: ['https://example.com/'] }, undefined, empty.fetcher)).isError, true);
});

test('a page Firecrawl cannot load and an error page each read truthfully', async () => {
  const page = { urls: ['https://example.com/'] };
  const dns = upstream(() => Response.json({ success: false, code: 'SCRAPE_DNS_RESOLUTION_ERROR', error: raw }));

  const site = upstream(() =>
    Response.json({ success: false, code: 'SCRAPE_SITE_ERROR', error: raw }, { status: 500 }),
  );

  const missing = upstream(() =>
    Response.json({ success: true, data: { markdown: 'Not found', metadata: { statusCode: 404 } } }),
  );

  const unresolved = await runFetch(KEY, page, undefined, dns.fetcher);
  assert.equal(unresolved.isError, true);
  assert.match(unresolved.text, /hostname does not resolve/);

  const refused = await runFetch(KEY, page, undefined, site.fetcher);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /site failed or refused/);
  assert.equal(refused.text.includes(raw), false);

  const notFound = await runFetch(KEY, page, undefined, missing.fetcher);
  assert.match(notFound.text, /answered HTTP 404/);
  assert.deepEqual(notFound.structured, { pages: [{ url: page.urls[0], status: 404 }], truncated: false });
});

test('several fetches share one output, and each search result keeps a place when the output is cut', async () => {
  const pages = upstream((call) =>
    String(call.body.url).endsWith('/bad')
      ? Response.json({ success: false, code: 'SCRAPE_SITE_ERROR' })
      : Response.json({ data: { markdown: `${call.body.url} `.repeat(4_000) } }),
  );

  const urls = ['https://a.example/', 'https://b.example/', 'https://c.example/bad', 'http://localhost/'];
  const fetched = await runFetch(KEY, { urls }, undefined, pages.fetcher);
  assert.equal(fetched.isError, false, 'one good page is a result');
  assert.equal(pages.calls.length, 3, 'a private host is never requested');
  assert.ok(fetched.text.length <= 50_100);

  for (const expected of ['a.example', 'b.example', 'site failed or refused', 'Private, local'])
    assert.ok(fetched.text.includes(expected) && fetched.full?.includes(expected), expected);

  const long = upstream(() =>
    Response.json({
      data: {
        web: [
          { url: 'https://a.example/', description: 'x'.repeat(40_000) + 'END-A' },
          { url: 'https://b.example/', description: 'y'.repeat(40_000) + 'END-B' },
        ],
      },
    }),
  );

  const found = await runSearch(KEY, { query: 'q' }, undefined, long.fetcher);
  assert.ok(found.text.includes('https://b.example/'), 'the second result is shown');
  assert.equal(found.text.includes('END-A'), false);
  assert.ok(found.full?.includes('END-A') && found.full.includes('END-B'));
  assert.ok(JSON.stringify(found.structured).length < 60_000, 'structured output is bounded');

  const short = upstream(() =>
    Response.json({ data: { web: [{ url: 'https://a.example/', description: 'z'.repeat(30_000) }] } }),
  );

  const whole = await runSearch(KEY, { query: 'q' }, undefined, short.fetcher);
  assert.ok(whole.text.includes('z'.repeat(30_000)), 'an output under the limit is not cut');
  assert.equal(whole.full, undefined);
});

test(
  'a cut web output is saved whole in one sandbox file, split only past the write limit',
  { timeout: 120_000 },
  async () => {
    const rig = await lifecycleRig({ FIRECRAWL_API_KEY: 'fc-test' });

    try {
      const session = await rig.create();
      const names = ['one', 'two', 'three', 'four', 'five'];
      let size = 0;
      const page = (name: string) => `START-${name} ${'p'.repeat(size)} END-${name}`;

      rig.setIntercept(({ path }) =>
        path === '/v2/search'
          ? Response.json({
              data: { web: names.map((name) => ({ url: `https://${name}.example/`, markdown: page(name) })) },
            })
          : undefined,
      );

      const search = async (pageSize: number, id: string) => {
        size = pageSize;
        const call = { id, name: 'web_search', arguments: { query: 'q', limit: 5, scrape: true } };
        await rig.accepted(await rig.send(session.id, 'Search', undefined, call));
        assert.equal((await rig.settled(session.id)).run.kind, 'completed');
        const output = toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '';
        assert.ok(output.length < 52_000, String(output.length));
        assert.match(output, /Output truncated\. Full output/);
        const paths = output.split('\n').filter((line) => line.startsWith('/'));

        const parts = await Promise.all(
          paths.map(async (path) => {
            const response = await rig.sandbox(session.workspace.id, '/bytes?path=' + encodeURIComponent(path));

            return Buffer.from(FileBytes.parse(await response.json()).content, 'base64').toString('utf8');
          }),
        );

        const whole = parts.join('');

        for (const name of names) assert.ok(whole.includes(page(name)), name);

        return paths;
      };

      const single = await search(150_000, 'call/1');
      assert.equal(single.length, 1, 'all five pages in one file');
      assert.ok(single[0]?.includes('/.cloud-swe/web/call_1.md'));

      assert.equal((await search(1_200_000, 'call-2')).length, 4, 'past 5 MiB it takes parts of 1.7M characters');
    } finally {
      await rig.close();
    }
  },
);
