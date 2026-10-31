/**
 * Path: server/test/sandbox-state.ts
 * Used by: server/test/{sandbox-tools,sandbox}.ts.
 * Purpose: The Docker sandbox double lifecycle state: per-workspace deadline, stop, resume and delete.
 */

// Lifecycle of the Docker test double, mirroring Boat: an auto-stop deadline that ignores activity, stop kills
// processes and keeps the disk, resume restarts after a short `starting` phase, delete is final.
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

/** `null` once deleted, like Boat's 404. */
export function stateOf(id: string) {
  return boxes.get(id)?.state ?? null;
}

export function track(id: string, pid: number | undefined) {
  if (pid !== undefined) boxes.get(id)?.pids.add(pid);
}

export function stop(id: string) {
  const box = boxes.get(id);

  if (!box || box.state === 'stopped') return;
  box.state = 'stopped';

  // Processes die with the machine; the disk stays.
  for (const pid of box.pids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }

  box.pids.clear();
}

/** Sets the deadline to now + ttl, like PATCH ttlSeconds. */
export function renew(id: string, ttlSeconds: number) {
  const box = boxes.get(id);

  if (!box) return;
  box.ttl = ttlSeconds;
  box.deadline = Date.now() + ttlSeconds * 1000;
}

export function resume(id: string, ttlSeconds: number | undefined) {
  const box = boxes.get(id);

  if (!box || box.state !== 'stopped') return;
  box.state = 'starting';
  renew(id, ttlSeconds ?? box.ttl);
  setTimeout(() => {
    if (box.state === 'starting') box.state = 'running';
  }, RESUME_MS);
}

export function remove(id: string) {
  stop(id);
  boxes.delete(id);
}

// Boat stops a sandbox when its deadline passes, even mid-command.
setInterval(() => {
  for (const [id, box] of boxes) if (box.state !== 'stopped' && Date.now() > box.deadline) stop(id);
}, 200).unref();
