import { defineRule } from '@oxlint/plugins';

// Only these create a session's first conversation; everything else follows the active one, which a rewind moves.
const CREATORS = [
  '/server/src/sessions/pi.ts',
  '/server/src/sessions/thread.ts',
  '/server/src/sessions/catalog-store.ts',
];

export const noFirstConversationRule = defineRule({
  meta: { type: 'problem', docs: { description: 'Read the active conversation instead of FIRST_CONVERSATION.' } },
  create(context) {
    if (CREATORS.some((path) => context.filename.endsWith(path))) return {};

    return {
      ImportSpecifier(node) {
        if (node.imported.type !== 'Identifier' || node.imported.name !== 'FIRST_CONVERSATION') return;
        context.report({
          node,
          message:
            'A rewind moves the active conversation off "1": read runtime.conversationId or Session.activeConversationId, and in tests pass the conversation ID to the rig after rig.rewind.',
        });
      },
    };
  },
});
