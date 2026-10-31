import { defineRule } from '@oxlint/plugins';

/** Durable Object names decide whose data a call reaches, so they are chosen in one place: env.ts. */
export const noStubLookupRule = defineRule({
  meta: { type: 'problem', docs: { description: 'Look up Durable Object stubs through env.ts.' } },
  create(context) {
    if (!context.filename.includes('/server/src/') || context.filename.endsWith('/server/src/env.ts')) return {};

    return {
      CallExpression(node) {
        const { callee } = node;

        if (callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'idFromName') {
          context.report({ node, message: 'Use catalogStub, credentialsStub or threadStub from env.ts.' });
        }
      },
    };
  },
});
