/**
 * Path: server/test/sandbox-state.ts
 * Used by: server/test/{sandbox-tools,sandbox}.ts.
 * Purpose: The Docker sandbox double lifecycle state: per-workspace deadline, stop, resume and delete.
 */

// Lifecycle of the Docker test double, mirroring an E2B pause: a deadline that ignores activity, stop freezes processes
// and keeps the disk, resume continues them after a short `starting` phase and only ever raises a running deadline,
// delete is final.
const DEFAULT_TTL_SECONDS = 3600;
const RESUME_MS = 1500;

type Box = { state: 'running' | 'starting' | 'stopped'; deadline: number; ttl: number; pids: Set<number> };

const boxes = new Map<string, Box>();

export function create(id: string) {
  if (!boxes.has(id))
    boxes.set(id, {
      state: 'running',
      deadline: Date.now() + DEFAULT_TTL_SECONDS * 1000,
      ttl: DEFAULT_TTL_SECONDS,
      pids: new Set(),
    });
}

/** `null` once deleted, like E2B's not-found. */
export function stateOf(id: string) {
  return boxes.get(id)?.state ?? null;
}

export function track(id: string, pid: number | undefined) {
  if (pid !== undefined) boxes.get(id)?.pids.add(pid);
}

function signal(box: Box, name: NodeJS.Signals) {
  for (const pid of box.pids) {
    try {
      process.kill(-pid, name);
    } catch {
      box.pids.delete(pid);
    }
  }
}

/** A pause: processes freeze where they are and the disk stays. */
export function stop(id: string) {
  const box = boxes.get(id);

  if (!box || box.state === 'stopped') return;
  box.state = 'stopped';
  signal(box, 'SIGSTOP');
}

/** Sets the deadline to now + ttl, like E2B's setTimeout. */
export function renew(id: string, ttlSeconds: number) {
  const box = boxes.get(id);

  if (!box) return;
  box.ttl = ttlSeconds;
  box.deadline = Date.now() + ttlSeconds * 1000;
}

/** Like E2B's connect: continues a paused sandbox, and on a running one only raises the deadline. */
export function resume(id: string, ttlSeconds: number | undefined) {
  const box = boxes.get(id);

  if (!box) return;
  const ttl = ttlSeconds ?? box.ttl;

  if (box.state !== 'stopped') {
    if (Date.now() + ttl * 1000 > box.deadline) renew(id, ttl);

    return;
  }

  box.state = 'starting';
  renew(id, ttl);
  setTimeout(() => {
    if (box.state !== 'starting') return;
    box.state = 'running';
    signal(box, 'SIGCONT');
  }, RESUME_MS);
}

export function remove(id: string) {
  const box = boxes.get(id);

  if (!box) return;
  signal(box, 'SIGKILL');
  boxes.delete(id);
}

// E2B pauses a sandbox when its deadline passes, even mid-command.
setInterval(() => {
  for (const [id, box] of boxes) if (box.state !== 'stopped' && Date.now() > box.deadline) stop(id);
}, 200).unref();
