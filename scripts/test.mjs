/**
 * Path: scripts/test.mjs
 * Used by: package.json (pnpm test).
 * Purpose: Runs the test suite in Docker Compose; each flag swaps one double for the real service (--e2b: billed E2B sandboxes, --github: real GitHub on the scratch repository, --anthropic: the billed real model), and flags compose.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// What each flag needs from the environment, and what it sets. Its variables reach the tests only when it is on.
const FLAGS = {
  '--e2b': { needs: ['E2B_API_KEY'], sets: { WORKSPACE_BACKEND: 'e2b' } },
  '--github': { needs: ['GITHUB_APP_CLIENT_ID', 'GITHUB_APP_PRIVATE_KEY'], sets: { GITHUB_BACKEND: 'github' } },
  '--anthropic': { needs: ['ANTHROPIC_API_KEY'], sets: { MODEL_BACKEND: 'anthropic' } },
};

const flags = new Set(process.argv.slice(2));

if ([...flags].some((flag) => !Object.hasOwn(FLAGS, flag))) {
  throw new Error('Usage: pnpm test [--e2b] [--github] [--anthropic]');
}

const env = { ...process.env, WORKSPACE_BACKEND: 'docker', GITHUB_BACKEND: 'fake', MODEL_BACKEND: 'scripted' };

for (const [flag, { needs, sets }] of Object.entries(FLAGS)) {
  if (!flags.has(flag)) {
    // Compose would otherwise read them from the root .env.
    for (const name of needs) env[name] = '';
    continue;
  }

  const missing = needs.filter((name) => !process.env[name]);

  if (missing.length > 0) throw new Error(`${flag} requires ${missing.join(' and ')} in the environment`);
  Object.assign(env, sets);
}

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
