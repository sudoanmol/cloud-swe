/**
 * Path: scripts/set-github-pat.mjs
 * Used by: `pnpm set-pat`.
 * Purpose: Uploads the fine-grained GitHub PAT on your clipboard to the Worker at PUBLIC_URL. Checks the Worker first, and never prints the token.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function die(message) {
  console.error(`set-pat: ${message}`);
  process.exit(1);
}

// Values already in the environment win, as with any .env loader.
if (existsSync('.env')) process.loadEnvFile('.env');

const { PUBLIC_URL, API_TOKEN } = process.env;

if (!PUBLIC_URL) die('PUBLIC_URL is not set in .env');

if (!API_TOKEN) die('API_TOKEN is not set in .env');

if (!/^https:\/\/[^/\s]+$/.test(PUBLIC_URL)) die('PUBLIC_URL must be an https base URL with no path or trailing slash');

const clipboard = spawnSync('pbpaste', { encoding: 'utf8' });

if (clipboard.status !== 0) die('could not read the clipboard');

const token = clipboard.stdout.trim();

if (!/^github_pat_\w+$/.test(token)) die('the clipboard does not hold a fine-grained PAT (github_pat_...)');

const endpoint = `${PUBLIC_URL}/v1/credentials/github`;
const headers = { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' };

async function call(init) {
  try {
    return await fetch(endpoint, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    die(`could not reach ${PUBLIC_URL}. Is the Worker deployed?`);
  }
}

/** The Worker's own JSON answer, or nothing when something else (such as a Cloudflare error page) replied. */
const body = (response) => response.json().catch(() => undefined);

const probe = await call({ method: 'GET' });
const status = await body(probe);

if (probe.status === 401) die(`${PUBLIC_URL} refused API_TOKEN. Does .env match the deployed secret?`);

if (!probe.ok || ![true, false].includes(status?.configured)) {
  die(`${endpoint} is not this Worker's PAT endpoint (HTTP ${probe.status}). Is the Worker deployed at PUBLIC_URL?`);
}

const upload = await call({ method: 'PUT', body: JSON.stringify({ token }) });
const result = await body(upload);

if (!upload.ok) die(result?.error?.message ?? `upload failed (HTTP ${upload.status})`);

console.log(`GitHub PAT stored on ${PUBLIC_URL} for ${result.login}.`);
