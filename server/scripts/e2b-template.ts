/**
 * Path: server/scripts/e2b-template.ts
 * Used by: server/package.json (pnpm --filter server e2b:template).
 * Purpose: Builds the `cloud-swe` E2B template that sessions run in. Rerun it after changing this recipe.
 */

import { defaultBuildLogger, Template } from 'e2b';

const template = Template()
  .fromUbuntuImage('24.04')
  .setUser('root')
  .runCmd(
    'apt-get update -qq && apt-get install -y -qq git curl ca-certificates build-essential python3 python3-pip unzip jq ripgrep postgresql redis-server',
  )
  .runCmd('curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y -qq nodejs && npm i -g pnpm')
  .runCmd('curl -fsSL https://get.docker.com | sh && usermod -aG docker user')
  .setEnvs({ PLAYWRIGHT_BROWSERS_PATH: '/opt/playwright' })
  .runCmd('npx -y playwright@latest install --with-deps chromium && chmod -R a+rX /opt/playwright')
  // E2B's image has no certificate at the path Postgres expects, so it won't start with SSL on (found live).
  .runCmd(
    `sed -i "s/^ssl = on/ssl = off/" /etc/postgresql/*/main/postgresql.conf; systemctl disable postgresql redis-server docker 2>/dev/null; true`,
  )
  .setWorkdir('/home/user')
  // Commands and files default to this user, so it must come last; root otherwise.
  .setUser('user');

await Template.build(template, 'cloud-swe', {
  cpuCount: 4,
  memoryMB: 8192,
  onBuildLogs: defaultBuildLogger(),
});
