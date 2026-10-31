import assert from 'node:assert/strict';
import test from 'node:test';

import { FileContent } from '@cloud-swe/protocol/tools';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { lifecycleRig } from './lifecycle-rig.ts';

test(
  'a cut web output is saved whole in the sandbox, split when very large, at the paths it gives',
  { timeout: 60_000 },
  async () => {
    const rig = await lifecycleRig({ FIRECRAWL_API_KEY: 'fc-test' });

    try {
      const session = await rig.create();
      const page = (name: string) => `START-${name} ${'p'.repeat(150_000)} END-${name}`;
      const names = ['one', 'two', 'three', 'four', 'five'];

      rig.setIntercept(({ path }) =>
        path === '/v2/search'
          ? Response.json({
              data: { web: names.map((name) => ({ url: `https://${name}.example/`, markdown: page(name) })) },
            })
          : undefined,
      );

      await rig.accepted(
        await rig.send(session.id, 'Search', undefined, {
          id: 'call/1',
          name: 'web_search',
          arguments: { query: 'q', limit: 5, scrape: true },
        }),
      );

      assert.equal((await rig.settled(session.id)).run.kind, 'completed');
      const output = toolResults(rig.bodies.at(-1) ?? '').at(-1)?.output ?? '';
      assert.ok(output.length < 52_000, String(output.length));
      assert.match(output, /Output truncated\. Full output/);
      const paths = output.split('\n').filter((line) => line.startsWith('/'));
      assert.equal(paths.length, 3, 'three files of 300,000 characters at most');
      assert.ok(paths.every((path) => path.includes('/.cloud-swe/web/call_1')));

      const parts = await Promise.all(
        paths.map(async (path) => {
          const response = await rig.sandbox(session.workspace.id, '/file?path=' + encodeURIComponent(path));

          return FileContent.parse(await response.json()).content;
        }),
      );

      const whole = parts.join('');

      for (const name of names) assert.ok(whole.includes(page(name)), name);
    } finally {
      await rig.close();
    }
  },
);
