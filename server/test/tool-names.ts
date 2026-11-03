/**
 * Path: server/test/tool-names.ts
 * Used by: server/test/{sessions.test,tools.test}.ts.
 * Purpose: Every tool a session offers, in registration order.
 */

// Every tool a session offers, in registration order. Tests that list them import this, so adding a tool edits one line.
export const TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'git_clone',
  'git_set_base_repo',
  'github_pr_create',
  'github_pr_update',
  'github_pr_close',
  'github_pr_reopen',
  'github_pr_comment',
  'github_pr_read',
  'git_request_ref_update',
  'github_pr_merge',
  'todo',
  'ask_user_question',
  'set_environment_variable',
  'codemode',
];
