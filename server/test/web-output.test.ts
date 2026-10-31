import assert from 'node:assert/strict';
import test from 'node:test';

import { FileBytes } from '@cloud-swe/protocol/tools';

import { toolResults } from '../../protocol/test/provider-request.ts';
import { lifecycleRig } from './lifecycle-rig.ts';

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
