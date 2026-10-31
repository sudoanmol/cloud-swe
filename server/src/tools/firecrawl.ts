/**
 * Path: server/src/tools/firecrawl.ts
 * Used by: server/src/tools/web.ts.
 * Purpose: The Firecrawl API client and the URL guard in front of it. Upstream errors become fixed messages, and the key goes nowhere but the request header.
 */

import { z } from 'zod';

export type SearchBody = {
  query: string;
  limit: number;
  sources: { type: 'web' | 'news' }[];
  categories?: { type: 'developer' | 'research' | 'pdf' }[];
  tbs?: string;
  includeDomains?: string[];
  scrapeOptions?: { formats: ['markdown']; onlyMainContent: true };
};

export type FetchBody = {
  url: string;
  formats: ['markdown'] | ['markdown', { type: 'question'; question: string }];
  onlyMainContent: boolean;
  maxAge?: number;
};

const API = 'https://api.firecrawl.dev/v2';
const SEARCH_TIMEOUT_MS = 45_000;
const FETCH_TIMEOUT_MS = 75_000;

const ResultSchema = z.object({
  title: z.string().optional(),
  url: z.string(),
  snippet: z.string().optional(),
  date: z.string().optional(),
  markdown: z.string().optional(),
});

export type SearchResult = z.infer<typeof ResultSchema>;

const SearchResponse = z.object({
  data: z.object({
    web: z
      .array(
        z.object({
          title: z.string().optional(),
          url: z.string(),
          description: z.string().optional(),
          markdown: z.string().optional(),
        }),
      )
      .default([]),
    news: z
      .array(
        z.object({
          title: z.string().optional(),
          url: z.string(),
          snippet: z.string().optional(),
          date: z.string().optional(),
          markdown: z.string().optional(),
        }),
      )
      .default([]),
  }),
});

const FetchResponse = z.object({
  data: z.object({
    markdown: z.string().optional(),
    answer: z.string().optional(),
    metadata: z
      .object({ title: z.string().optional(), sourceURL: z.string().optional(), statusCode: z.number().optional() })
      .optional(),
  }),
});

// Firecrawl reports a page it could not load this way, on HTTP 200 as well as on errors.
const ScrapeRefusal = z.object({ success: z.literal(false), code: z.string().startsWith('SCRAPE_') });

/** Fixed messages only: raw upstream text is never echoed. */
function statusMessage(status: number): string {
  if (status === 401 || status === 403) return 'Web access failed: Firecrawl rejected the server API key';

  if (status === 402) return 'Web access failed: Firecrawl credits are exhausted';

  if (status === 429) return 'Web access failed: Firecrawl rate limit reached, try again later';

  if (status === 408 || status === 504) return 'Web access failed: Firecrawl timed out';

  return `Web access failed: Firecrawl request failed (HTTP ${status})`;
}

function scrapeMessage(code: string): string {
  return code === 'SCRAPE_DNS_RESOLUTION_ERROR'
    ? 'The page could not be loaded: its hostname does not resolve'
    : 'The page could not be loaded: the site failed or refused the request';
}

type Fetched<T> = { ok: true; value: T } | { ok: false; message: string };

async function post<T extends z.ZodType>(
  fetcher: typeof fetch,
  key: string,
  path: string,
  body: (SearchBody | FetchBody) & { timeout: number },
  schema: T,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Fetched<z.infer<T>>> {
  const timeout = AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetcher(API + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    const payload: unknown = await response.json().catch(() => undefined);
    const refusal = ScrapeRefusal.safeParse(payload);

    if (refusal.success) return { ok: false, message: scrapeMessage(refusal.data.code) };

    if (!response.ok) return { ok: false, message: statusMessage(response.status) };
    const parsed = schema.safeParse(payload);

    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, message: 'Web access failed: Firecrawl returned an unexpected response' };
  } catch {
    return { ok: false, message: 'Web access failed: the Firecrawl request did not complete' };
  }
}

export function search(key: string, body: SearchBody, signal: AbortSignal | undefined, fetcher: typeof fetch) {
  const request = { ...body, timeout: SEARCH_TIMEOUT_MS - 5_000 };

  return post(fetcher, key, '/search', request, SearchResponse, SEARCH_TIMEOUT_MS, signal);
}

export function scrape(key: string, body: FetchBody, signal: AbortSignal | undefined, fetcher: typeof fetch) {
  const request = { ...body, timeout: FETCH_TIMEOUT_MS - 10_000 };

  return post(fetcher, key, '/scrape', request, FetchResponse, FETCH_TIMEOUT_MS, signal);
}

function privateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  const [a = 0, b = 0] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** WHATWG URL already folds decimal, hex and octal IPv4 and IPv4-mapped IPv6 into canonical hostnames. */
function privateHost(hostname: string): boolean {
  if (hostname.startsWith('[')) {
    const ip = hostname.slice(1, -1).toLowerCase();
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);

    if (mapped) {
      const high = parseInt(mapped[1] ?? '0', 16);
      const low = parseInt(mapped[2] ?? '0', 16);

      return privateIPv4([high >> 8, high & 255, low >> 8, low & 255].join('.'));
    }

    // Unspecified, loopback, unique-local fc00::/7, link-local fe80::/10, deprecated site-local fec0::/10, and any
    // other ::ffff:/96 or ::/96 form.
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89a-f]/.test(ip) || ip.startsWith('::');
  }

  // `localhost.` is the same host as `localhost`; the trailing dots must not hide it from the checks below.
  const host = hostname.replace(/\.+$/, '');

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return privateIPv4(host);

  return (
    !host.includes('.') ||
    host === 'localhost' ||
    ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'].some((suffix) => host.endsWith(suffix))
  );
}

/** Firecrawl fetches the page, but a private target would still be a request the agent must not be able to aim. */
export function rejectUrl(raw: string): string | undefined {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return 'Invalid URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https URLs can be fetched';

  if (url.username || url.password) return 'URLs with embedded credentials are not allowed';

  if (url.port !== '' && url.port !== '80' && url.port !== '443')
    return 'Only the standard ports 80 and 443 are allowed';

  return privateHost(url.hostname) ? 'Private, local and internal hosts are not allowed' : undefined;
}
