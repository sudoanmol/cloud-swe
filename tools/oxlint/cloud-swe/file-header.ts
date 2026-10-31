/**
 * Path: tools/oxlint/cloud-swe/file-header.ts
 * Used by: tools/oxlint/cloud-swe/index.ts.
 * Purpose: Checks that a file over the size limit opens with an accurate Path / Used by / Purpose header, so a reader can place it at a glance.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

// At or under this many lines a file is short enough to read instead.
export const HEADER_REQUIRED_OVER_LINES = 20;

const ROOT = join(import.meta.dirname, '../../..');

const SOURCE_ROOTS = [
  'server/src',
  'server/test',
  'protocol/src',
  'protocol/test',
  'scripts',
  'tools/oxlint/cloud-swe',
];

const IMPORT = /^(?:import|export)\b[^;]*?\bfrom\s+'(\.[^']+)'/gm;
const HEADER = /^\/\*\*\n \* Path: (.+)\n \* Used by: (.+)\n \* Purpose: (.+)\n \*\/\n\n/;

const sourceFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(join(ROOT, path)).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);

    return /\.(ts|mjs)$/.test(name) ? [path] : [];
  });

const tree = (path: string) => (path.includes('/test/') || path.endsWith('.test.ts') ? 'test' : 'src');

let importersByFile: Map<string, Set<string>> | undefined;

/** Which files import each file, within the same tree: tests are not listed on the source they exercise. */
function importers(path: string): Set<string> {
  if (!importersByFile) {
    importersByFile = new Map();

    for (const importer of SOURCE_ROOTS.flatMap(sourceFiles)) {
      for (const [, specifier] of readFileSync(join(ROOT, importer), 'utf8').matchAll(IMPORT)) {
        const target = normalize(join(dirname(importer), specifier ?? ''));

        if (tree(importer) !== tree(target)) continue;
        importersByFile.set(target, (importersByFile.get(target) ?? new Set()).add(importer));
      }
    }
  }

  return importersByFile.get(path) ?? new Set();
}

/** `a/{b,c}.ts, d.ts (why)` lists a/b.ts, a/c.ts and d.ts. */
export function listedPaths(usedBy: string): string[] {
  return (usedBy.match(/[\w./-]*(?:\{[^}]+\})?[\w./-]*\.\w+/g) ?? []).flatMap((token) => {
    const braces = /^(.*)\{([^}]+)\}(.*)$/.exec(token);

    return braces ? (braces[2] ?? '').split(',').map((part) => `${braces[1]}${part}${braces[3]}`) : [token];
  });
}

type Facts = { path: string; text: string; importers: ReadonlySet<string>; exists: (path: string) => boolean };

/** Everything wrong with this file's header, as messages. */
export function headerProblems({ path, text, importers: actual, exists }: Facts): string[] {
  const header = HEADER.exec(text);

  if (!header) {
    if (text.trimEnd().split('\n').length <= HEADER_REQUIRED_OVER_LINES && !text.startsWith('/**\n * Path:')) return [];

    return [
      'Start this file with a /** Path / Used by / Purpose */ header followed by a blank line; without the blank line oxfmt moves it when it sorts imports.',
    ];
  }

  const [, stated, usedBy = ''] = header;
  const problems = stated === path ? [] : [`Path says ${stated}; this file is ${path}.`];
  const listed = listedPaths(usedBy);

  for (const missing of listed.filter((entry) => !exists(entry)))
    problems.push(`Used by names ${missing}, which does not exist.`);

  for (const importer of actual) if (!listed.includes(importer)) problems.push(`Used by is missing ${importer}.`);

  for (const entry of listed) {
    if (/\.(ts|mjs)$/.test(entry) && exists(entry) && !actual.has(entry))
      problems.push(`Used by names ${entry}, which does not import this file.`);
  }

  return problems;
}

export const fileHeaderRule = {
  meta: { type: 'suggestion', docs: { description: 'Require an accurate Path / Used by / Purpose file header.' } },
  create(context: {
    filename: string;
    sourceCode: { text: string };
    report: (problem: { message: string; loc: { line: number; column: number } }) => void;
  }) {
    const path = relative(ROOT, context.filename);

    return {
      Program() {
        const problems = headerProblems({
          path,
          text: context.sourceCode.text,
          importers: importers(path),
          exists: (entry) => existsSync(join(ROOT, entry)),
        });

        for (const message of problems) context.report({ message, loc: { line: 1, column: 0 } });
      },
    };
  },
};
