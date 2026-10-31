/**
 * Path: server/src/sessions/workspace-lifecycle.ts
 * Used by: server/src/sessions/{catalog,create}.ts.
 * Purpose: The catalog's view of each sandbox: believed state, live inspection, resume, keep-alive renewals, the MAX_SANDBOXES cap and the idle-delete sweep.
 */
import type { Session } from '@cloud-swe/protocol';
import type { WorkspaceEntry } from '@cloud-swe/protocol/storage';
import { Effect } from 'effect';

import type { Env } from '../env.ts';
import { apiError } from '../errors.ts';
import { WorkspaceError } from '../workspaces/errors.ts';
import {
  deleteWorkspace,
  inspectWorkspace,
  renewWorkspace,
  resumeWorkspace,
  waitForWorkspace,
} from '../workspaces/index.ts';
import { IDLE_TTL_SECONDS, workspaceSettings } from '../workspaces/settings.ts';
import { listWorkspaces, readWorkspace, runningCount } from './catalog-store.ts';

type State = Session['workspace']['state'];

export type ResumeResult = { ok: true; resumed: boolean } | { ok: false; reason: 'limit' | 'expired' | 'unavailable' };

// Reads reuse a live inspection this long, so listing many sessions is not one Boat call each.
const FRESH_MS = 15_000;

// A failed delete is tried again after this long.
const DELETE_RETRY_MS = 60 * 60 * 1000;

/** The 409 for a session creation or message that needs a sandbox slot while MAX_SANDBOXES are running. */
export function sandboxLimitError(env: Pick<Env, 'MAX_SANDBOXES'>) {
  return apiError('sandbox_limit_reached', { limit: workspaceSettings(env).maxSandboxes });
}

/** Runs a workspace Effect and returns its failure instead of throwing. */
async function failure(effect: Effect.Effect<unknown, WorkspaceError>): Promise<WorkspaceError | undefined> {
  const result = await Effect.runPromise(
    effect.pipe(
      Effect.as(undefined),
      Effect.orElseSucceed((error) => error),
    ),
  );

  return result instanceof WorkspaceError ? result : undefined;
}

/**
 * Stored `running` means the sandbox counts toward the cap: it is on, or Boat has not yet told us it stopped.
 * Boat auto-stops silently, so the stored state can be stale. Whenever it matters (a read of the state, a resume, a
 * full cap), the live state is inspected and the stored one corrected.
 */
export class WorkspaceLifecycle {
  private readonly checked = new Map<string, { state: State; at: number }>();
  private readonly resuming = new Map<string, Promise<ResumeResult>>();
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;

  constructor(storage: DurableObjectStorage, env: Env) {
    this.storage = storage;
    this.env = env;
  }

  /** Applies a change to one stored entry atomically. A deleted entry never changes again. */
  private async patch(id: string, change: (entry: WorkspaceEntry) => WorkspaceEntry): Promise<WorkspaceEntry> {
    return this.storage.transaction(async (tx) => {
      const current = await readWorkspace(tx, id);

      if (!current) throw new Error('Workspace not found');

      if (current.state === 'deleted') return current;
      const next = change(current);
      await tx.put(`workspace:${id}`, next);

      return next;
    });
  }

  private async inspect(entry: WorkspaceEntry): Promise<State> {
    const live = await Effect.runPromise(
      inspectWorkspace(this.env, entry.sandboxId).pipe(Effect.orElseSucceed((): State => 'unreachable')),
    );

    this.checked.set(entry.id, { state: live, at: Date.now() });

    // `starting` counts as running; an unreachable read says nothing about the sandbox.
    const believed = live === 'starting' ? 'running' : live;

    if ((believed === 'running' || believed === 'stopped' || believed === 'deleted') && believed !== entry.state)
      await this.patch(entry.id, (e) => ({ ...e, state: believed }));

    return live;
  }

  /** The state clients see. `fresh` skips the short-lived cache. */
  async state(entry: WorkspaceEntry, fresh = false): Promise<State> {
    if (entry.state === 'deleted') return 'deleted';

    if (this.resuming.has(entry.id)) return 'starting';
    const hit = this.checked.get(entry.id);

    if (!fresh && hit && Date.now() - hit.at < FRESH_MS) return hit.state;

    return this.inspect(entry);
  }

  /** Whether another sandbox may run. When the stored count says no, correct it against Boat before refusing. */
  async hasRoom(except?: string): Promise<boolean> {
    const { maxSandboxes } = workspaceSettings(this.env);

    if ((await runningCount(this.storage, except)) < maxSandboxes) return true;
    await this.refreshRunning();

    return (await runningCount(this.storage, except)) < maxSandboxes;
  }

  private async refreshRunning(): Promise<void> {
    const entries = await listWorkspaces(this.storage);

    // A sandbox being resumed may still read `stopped`; its resume sets the state when it is done.
    await Promise.all(
      entries
        .filter((entry) => entry.state === 'running' && !this.resuming.has(entry.id))
        .map((entry) => this.inspect(entry)),
    );
  }

  /** Called before a creation is admitted, so the admission gate itself only counts stored state. */
  async refreshIfFull(): Promise<void> {
    if ((await runningCount(this.storage)) >= workspaceSettings(this.env).maxSandboxes) await this.refreshRunning();
  }

  /** Records activity and makes sure the delete sweep is scheduled. */
  async touch(id: string): Promise<void> {
    await this.patch(id, (entry) => ({ ...entry, lastActiveAt: new Date().toISOString() }));
    await this.scheduleSweep();
  }

  async scheduleSweep(): Promise<void> {
    if ((await this.storage.getAlarm()) === null)
      await this.storage.setAlarm(Date.now() + workspaceSettings(this.env).deleteAfterMs);
  }

  /** Start the session's sandbox if it is stopped. Concurrent callers share one resume. */
  resume(id: string): Promise<ResumeResult> {
    const running = this.resuming.get(id);

    if (running) return running;
    const task = this.startResume(id).finally(() => this.resuming.delete(id));
    this.resuming.set(id, task);

    return task;
  }

  private async startResume(id: string): Promise<ResumeResult> {
    const entry = await readWorkspace(this.storage, id);

    if (!entry) throw new Error('Workspace not found');

    if (entry.state === 'deleted') return { ok: false, reason: 'expired' };
    const live = await this.inspect(entry);

    if (live === 'deleted') return { ok: false, reason: 'expired' };

    if (live === 'running') {
      await this.touch(id);

      return { ok: true, resumed: false };
    }

    if (live === 'stopped') {
      if (!(await this.hasRoom(id))) return { ok: false, reason: 'limit' };

      // Count toward the cap while starting, so a second resume cannot overshoot it.
      await this.patch(id, (e) => ({ ...e, state: 'running', lastActiveAt: new Date().toISOString() }));
      const { ttlSeconds } = workspaceSettings(this.env);
      const failed = await failure(resumeWorkspace(this.env, entry.sandboxId, ttlSeconds));

      if (failed) {
        if (failed.reason === 'expired') {
          await this.patch(id, (e) => ({ ...e, state: 'deleted' }));

          return { ok: false, reason: 'expired' };
        }

        await this.patch(id, (e) => ({ ...e, state: 'stopped' }));

        return { ok: false, reason: 'unavailable' };
      }
    } else if (live !== 'starting') {
      return { ok: false, reason: 'unavailable' };
    }

    // Right after a resume Boat may still read `stopped`, so wait through both.
    const after = await Effect.runPromise(
      waitForWorkspace(this.env, entry.sandboxId, ['starting', 'stopped']).pipe(
        Effect.orElseSucceed((): State => 'unreachable'),
      ),
    );

    this.checked.set(id, { state: after, at: Date.now() });

    if (after === 'deleted') {
      await this.patch(id, (e) => ({ ...e, state: 'deleted' }));

      return { ok: false, reason: 'expired' };
    }

    if (after !== 'running') return { ok: false, reason: 'unavailable' };

    // Boat read `stopped` right after the resume, and any inspection of that moment corrected the stored state to it.
    await this.patch(id, (e) => ({ ...e, state: 'running' }));
    await this.scheduleSweep();

    return { ok: true, resumed: true };
  }

  /**
   * One keep-alive step. `active` pushes Boat's auto-stop deadline out and counts as activity. `finished` shortens it
   * to IDLE_TTL_SECONDS so the sandbox stops soon after the run and frees its slot.
   * Returns the live state when the sandbox turns out to be stopped or deleted; any other failure throws for retry.
   */
  async keepAlive(id: string, mode: 'active' | 'finished'): Promise<State> {
    const entry = await readWorkspace(this.storage, id);

    if (!entry) throw new Error('Workspace not found');

    if (entry.state === 'deleted') return 'deleted';
    const ttl = mode === 'active' ? workspaceSettings(this.env).ttlSeconds : IDLE_TTL_SECONDS;
    const failed = await failure(renewWorkspace(this.env, entry.sandboxId, ttl));

    if (failed) {
      const live = await this.inspect(entry);

      if (live === 'stopped' || live === 'deleted') return live;
      throw new Error('Keep-alive failed');
    }

    if (mode === 'active') await this.touch(id);

    return 'running';
  }

  /** The alarm: delete sandboxes idle past the limit, then wake again for the next one. */
  async sweep(): Promise<void> {
    const { deleteAfterMs } = workspaceSettings(this.env);
    let next = Infinity;

    for (const { id } of await listWorkspaces(this.storage)) {
      // Each delete takes a while, so an entry from the list may have seen activity since. Decide on its current state.
      const entry = await readWorkspace(this.storage, id);

      if (!entry || (entry.state === 'deleted' && !entry.deletePending)) continue;
      const due = Date.parse(entry.lastActiveAt) + deleteAfterMs;

      if (due > Date.now() && !entry.deletePending) {
        next = Math.min(next, due);
        continue;
      }

      // Claimed first, so no message can resume or touch a sandbox that this call is about to delete.
      await this.patch(entry.id, (e) => ({ ...e, state: 'deleted', deletePending: true }));
      const failed = await failure(deleteWorkspace(this.env, entry.sandboxId));

      if (failed) next = Math.min(next, Date.now() + DELETE_RETRY_MS);
      else await this.patch(entry.id, ({ deletePending: _done, ...e }) => e);
    }

    if (next !== Infinity) await this.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }
}
