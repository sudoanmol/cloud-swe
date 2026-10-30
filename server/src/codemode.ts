import { CodemodeSandboxDurableObject } from '@earendil-works/pi-codemode/cloudflare';

// Separate Worker: a CPU-bound script must not block the Thread's SSE or cancellation.
export default {
  fetch: () => new Response(null, { status: 404 }),
};

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
  protected override maxInterruptBudget = 20_000;
  protected override maxMemoryLimitBytes = 32 * 1024 * 1024;
}
