/**
 * Path: scripts/test.mjs
 * Used by: package.json (pnpm test).
 * Purpose: Runs the test suite in Docker Compose, with --e2b for real, billed E2B sandboxes.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const flags = process.argv.slice(2);

const KEYS = { '--e2b': 'E2B_API_KEY' };

if (flags.length > 1 || flags.some((flag) => !Object.hasOwn(KEYS, flag))) {
  throw new Error('Usage: pnpm test [--e2b]');
}

const backend = flags[0]?.slice(2) ?? 'docker';

if (flags[0] && !process.env[KEYS[flags[0]]]) {
  throw new Error(`${flags[0]} requires ${KEYS[flags[0]]} in the environment`);
}

const env = { ...process.env, WORKSPACE_BACKEND: backend };

// One project per checkout, so parallel worktrees don't share or tear down each other's containers.
const project = `cloud-swe-tests-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8)}`;

const compose = ['compose', '--project-name', project];

try {
  const result = spawnSync('docker', [...compose, 'run', '--build', '--rm', 'tests'], { stdio: 'inherit', env });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const cleanup = spawnSync('docker', [...compose, 'down', '--remove-orphans'], { stdio: 'inherit', env });

  if (cleanup.status !== 0) process.exitCode = 1;
}
