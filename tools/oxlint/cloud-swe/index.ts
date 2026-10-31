import { eslintCompatPlugin } from '@oxlint/plugins';

import { fileHeaderRule } from './file-header.ts';
import { noStubLookupRule } from './no-stub-lookup.ts';
import { relativeImportExtensionRule } from './relative-import-extension.ts';

/** This repo's own rules. Vendored anti-slop stays unmodified; see its UPSTREAM.md. */
export default eslintCompatPlugin({
  meta: { name: 'cloud-swe' },
  rules: {
    'file-header': fileHeaderRule,
    'no-stub-lookup': noStubLookupRule,
    'relative-import-extension': relativeImportExtensionRule,
  },
});
