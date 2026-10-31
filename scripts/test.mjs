/**
 * Path: scripts/test.mjs
 * Used by: package.json (pnpm test).
 * Purpose: Runs the test suite in Docker Compose, with --boat for real Boat sandboxes.
 */

import { spawnSync } from 'node:child_process';

const flags = process.argv.slice(2);

if (flags.some((flag) => flag !== '--boat')) {
  throw new Error('Usage: pnpm test [--boat]');
}

const backend = flags.includes('--boat') ? 'boat' : 'docker';

if (backend === 'boat' && !process.env.BOAT_API_KEY) {
  throw new Error('--boat requires BOAT_API_KEY in the environment');
}

const env = { ...process.env, WORKSPACE_BACKEND: backend };
const compose = ['compose', '--project-name', 'cloud-swe-tests'];

try {
  const result = spawnSync('docker', [...compose, 'run', '--build', '--rm', 'tests'], { stdio: 'inherit', env });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const cleanup = spawnSync('docker', [...compose, 'down', '--remove-orphans'], { stdio: 'inherit', env });

  if (cleanup.status !== 0) process.exitCode = 1;
}
