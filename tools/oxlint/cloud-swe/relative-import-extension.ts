import { defineRule, type ESTree } from '@oxlint/plugins';

/** Node's type stripping only loads explicit paths, so a missing extension decides what a test is able to import. */
export const relativeImportExtensionRule = defineRule({
  meta: { type: 'problem', docs: { description: 'Relative imports name the file, with its extension.' } },
  create(context) {
    const check = (node: ESTree.ImportDeclaration | ESTree.ExportNamedDeclaration | ESTree.ExportAllDeclaration) => {
      const specifier = node.source?.value;

      if (specifier?.startsWith('.') && !/\.(ts|mjs|md)$/.test(specifier)) {
        context.report({ node, message: `Name the file: ${specifier} needs its extension.` });
      }
    };

    return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
  },
});
