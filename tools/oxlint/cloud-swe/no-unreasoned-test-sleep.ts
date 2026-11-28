import { defineRule, type ESTree } from '@oxlint/plugins';

const MESSAGE =
  'A fixed sleep races the Worker and slows the suite. Wait for the state itself with waitFor from rig.ts. When the sleep is the point (a slow double, a quiet period, a real server timer), say why in a comment right above it.';

export const noUnreasonedTestSleepRule = defineRule({
  meta: { type: 'suggestion', docs: { description: 'Require a reason above every fixed sleep in a test.' } },
  create(context) {
    if (!context.filename.endsWith('.test.ts')) return {};

    return {
      AwaitExpression(node) {
        const { argument } = node;

        const callee = argument.type === 'CallExpression' ? argument.callee : undefined;

        if (callee?.type !== 'Identifier' || callee.name !== 'setTimeout') return;

        let statement: ESTree.Node = node;

        while (statement.parent.type !== 'BlockStatement' && statement.parent.type !== 'Program')
          statement = statement.parent;

        if (context.sourceCode.getCommentsBefore(statement).length === 0) context.report({ node, message: MESSAGE });
      },
    };
  },
});
