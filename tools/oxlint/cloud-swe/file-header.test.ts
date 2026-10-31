import assert from 'node:assert/strict';
import test from 'node:test';

import { HEADER_REQUIRED_OVER_LINES, headerProblems, listedPaths } from './file-header.ts';

const long = 'const a = 1;\n'.repeat(HEADER_REQUIRED_OVER_LINES + 1);
const header = (path: string, usedBy: string) => `/**\n * Path: ${path}\n * Used by: ${usedBy}\n * Purpose: x\n */\n\n`;

const problems = (text: string, actual: string[] = []) =>
  headerProblems({ path: 'a/b.ts', text, importers: new Set(actual), exists: (path) => path !== 'a/gone.ts' });

test('used-by lists expand braces and ignore the words around paths', () => {
  assert.deepEqual(listedPaths('server/src/{a,b}.ts, c/d.ts (the proxy calls it), wrangler.jsonc.'), [
    'server/src/a.ts',
    'server/src/b.ts',
    'c/d.ts',
    'wrangler.jsonc',
  ]);
});

test('a short file needs no header and a long one does', () => {
  assert.deepEqual(problems('const a = 1;\n'), []);
  assert.equal(problems(long).length, 1);
});

test('a header with no blank line after it is refused, because the formatter would move it', () => {
  assert.equal(problems(header('a/b.ts', 'c.ts').trimEnd() + '\n' + long).length, 1);
});

test('the path and importers must match the code', () => {
  assert.deepEqual(problems(header('a/b.ts', 'a/c.ts.') + long, ['a/c.ts']), []);
  assert.match(problems(header('a/x.ts', 'a/c.ts.') + long, ['a/c.ts'])[0] ?? '', /Path says/);
  assert.match(problems(header('a/b.ts', 'a/c.ts.') + long, ['a/c.ts', 'a/d.ts'])[0] ?? '', /missing a\/d\.ts/);
  assert.match(problems(header('a/b.ts', 'a/c.ts.') + long)[0] ?? '', /does not import/);
  assert.match(problems(header('a/b.ts', 'a/gone.ts.') + long)[0] ?? '', /does not exist/);
});
