/**
 * Path: server/src/tools/runner.ts
 * Used by: server/src/tools/{commands,command-records,registry}.ts.
 * Purpose: Builds the Node supervisor that runs inside the sandbox and writes heartbeat, output and exit progress to a file.
 */
import type { CommandRecord } from '@cloud-swe/protocol';
import type { ShellInput } from '@cloud-swe/protocol/tools';

export const BASH_MAX_TIMEOUT_SECONDS = 600;

export function commandPrefix(identity: CommandRecord['identity']): string {
  return '/tmp/cloud-swe-' + identity.workspaceId + '-' + identity.operationId;
}

function quote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

// A per-invocation supervisor, not a daemon. The exclusive claim forbids duplicate shell execution.
// Cancellation addresses this UUID's marker, never a stale PID recovered across a restart.
const supervisor = String.raw`
const fs = await import('node:fs');
const { spawn } = await import('node:child_process');
const { identity, command, cwd, timeoutSeconds, prefix } = JSON.parse(process.argv[1]);
try { fs.mkdirSync(prefix + '.lock', { mode: 0o700 }); }
catch { process.exit(1); }
let output = '', outputBytes = 0, heartbeat = 0, finished = false, termination = 'exit', killer;
const save = (extra) => {
  fs.writeFileSync(prefix + '.next', JSON.stringify({
    identity, output, outputBytes, ...extra
  }), { mode: 0o600 });
  fs.renameSync(prefix + '.next', prefix + '.json');
};
const append = (chunk) => {
  outputBytes += Buffer.byteLength(chunk);
  // The spill log is best effort: a noisy command must not fill the disk or kill its supervisor.
  if (outputBytes <= 100_000_000) {
    try { fs.appendFileSync(prefix + '.log', chunk, { mode: 0o600 }); } catch {}
  }
  const bytes = Buffer.from(output + chunk);
  let start = Math.max(0, bytes.length - 64000);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  output = bytes.subarray(start).toString();
};
save({ kind: 'running', heartbeat });
if (fs.existsSync(prefix + '.cancel')) {
  save({ kind: 'exited', exitCode: 130, termination: 'cancelled' });
  process.exit(0);
}
const child = spawn('bash', ['-lc', command], {
  detached: true, cwd, stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', append);
child.stderr.on('data', append);
const signal = (name) => {
  try { process.kill(-child.pid, name); } catch {}
};
const stop = (reason) => {
  if (finished || termination !== 'exit') return;
  termination = reason;
  signal('SIGTERM');
  killer = setTimeout(() => signal('SIGKILL'), 2000);
};
const timer = setTimeout(() => stop('timeout'), timeoutSeconds * 1000);
const tick = setInterval(() => {
  if (fs.existsSync(prefix + '.cancel')) stop('cancelled');
  save({ kind: 'running', heartbeat: ++heartbeat });
}, 200);
const finish = (code) => {
  if (finished) return;
  finished = true;
  clearInterval(tick);
  clearTimeout(timer);
  clearTimeout(killer);
  save({ kind: 'exited', exitCode: code ?? 128, termination });
  process.exit(0);
};
child.on('error', () => append('Unable to start shell'));
// A background process can hold stdout open forever, so the shell's exit decides, after a moment to drain output.
child.on('exit', (code) => setTimeout(() => finish(code), 1000));
child.on('close', (code) => finish(code));
process.on('SIGTERM', () => stop('cancelled'));
process.on('SIGINT', () => stop('cancelled'));
`;

export function supervisorCommand(identity: CommandRecord['identity'], input: ShellInput): string {
  const intent = { identity, ...input, prefix: commandPrefix(identity) };

  return 'node --input-type=module -e ' + quote(supervisor) + ' ' + quote(JSON.stringify(intent));
}
