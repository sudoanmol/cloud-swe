type Node = { source?: { value: string } | null };

/** Node's type stripping only loads explicit paths, so a missing extension decides what a test is able to import. */
export const relativeImportExtensionRule = {
  meta: { type: 'problem', docs: { description: 'Relative imports name the file, with its extension.' } },
  create(context: { report: (problem: { node: Node; message: string }) => void }) {
    const check = (node: Node) => {
      const specifier = node.source?.value;

      if (specifier?.startsWith('.') && !/\.(ts|mjs|md)$/.test(specifier)) {
        context.report({ node, message: `Name the file: ${specifier} needs its extension.` });
      }
    };

    return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
  },
};
