type Node = { callee: { type: string; property?: { name?: string } } };

/** Durable Object names decide whose data a call reaches, so they are chosen in one place: env.ts. */
export const noStubLookupRule = {
  meta: { type: 'problem', docs: { description: 'Look up Durable Object stubs through env.ts.' } },
  create(context: { filename: string; report: (problem: { node: Node; message: string }) => void }) {
    if (!context.filename.includes('/server/src/') || context.filename.endsWith('/server/src/env.ts')) return {};

    return {
      CallExpression(node: Node) {
        if (node.callee.type === 'MemberExpression' && node.callee.property?.name === 'idFromName') {
          context.report({ node, message: 'Use catalogStub, credentialsStub or threadStub from env.ts.' });
        }
      },
    };
  },
};
