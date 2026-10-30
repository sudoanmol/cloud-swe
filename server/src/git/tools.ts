/**
 * Path: server/src/git/tools.ts
 * Used by: server/src/tools/registry.ts.
 * Purpose: The Git and GitHub tools registered with Pi. There is no git_push: agents push with git through the proxy.
 */
import type { ToolRegistration } from '@earendil-works/pi-durable';

import type { ToolHost } from '../tools/host';
import { approvalTools } from './approval-tools';
import { pullRequestTools } from './pull-request-tools';
import { repoTools } from './repo-tools';

export function gitTools(host: ToolHost): ToolRegistration[] {
  return [...repoTools(host), ...pullRequestTools(host), ...approvalTools(host)];
}
