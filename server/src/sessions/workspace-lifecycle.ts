/**
 * Path: server/src/sessions/workspace-lifecycle.ts
 * Used by: server/src/sessions/{catalog,routes,thread}.ts.
 * Purpose: The catalog's view of each sandbox: admission and provisioning, believed state, live inspection, resume, replacement, keep-alive renewals and the idle-delete sweep.
 */

import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation, WorkspaceEntry } from '@cloud-swe/protocol/storage';
import { Effect } from 'effect';

import type { Env } from '../env.ts';
import { WorkspaceError } from '../workspaces/errors.ts';
import {
  deleteWorkspace,
  inspectWorkspace,
  renewWorkspace,
  resumeWorkspace,
  waitForWorkspace,
} from '../workspaces/index.ts';
import { IDLE_TTL_SECONDS, workspaceSettings } from '../workspaces/settings.ts';
import { listWorkspaces, readWorkspace, writeWorkspace } from './catalog-store.ts';
import { admitReplacement, atCapacity, ensureWorkspace, type ReplacementRefusal } from './create.ts';
import { singleFlight } from './idempotency.ts';

type State = Session['workspace']['state'];

export type ResumeResult = { ok: true } | { ok: false; reason: 'limit' | 'expired' | 'unavailable' };

type Replacement = { ok: true; workspaceId: string } | ReplacementRefusal;

// Reads reuse a live inspection this long, so listing many sessions is not one provider call each.
const FRESH_MS = 15_000;

// A failed delete is tried again after this long.
const DELETE_RETRY_MS = 60 * 60 * 1000;

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
 * Stored `running` means the sandbox counts toward the cap: it is on, or the provider has not yet told us it stopped.
 * Providers auto-stop silently, so the stored state can be stale. Whenever it matters (a read of the state, a resume, a
 * full cap), the live state is inspected and the stored one corrected.
 */
export class WorkspaceLifecycle {
  private readonly checked = new Map<string, { state: State; at: number }>();
  private readonly resuming = singleFlight<ResumeResult>();
  private readonly replacing = singleFlight<Replacement>();
  private readonly ctx: DurableObjectState;
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env;
  }

  /** Applies a change to one stored entry atomically. A deleted entry never changes again. */
  private async patch(id: string, change: (entry: WorkspaceEntry) => WorkspaceEntry): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const current = await readWorkspace(tx, id);

      if (!current) throw new Error('Workspace not found');

      if (current.state !== 'deleted') await writeWorkspace(tx, change(current));
    });
  }

  private async setState(id: string, state: WorkspaceEntry['state']): Promise<void> {
    await this.patch(id, (entry) => ({ ...entry, state }));
  }

  /** Counts toward the cap and records activity, and makes sure the delete sweep is scheduled. */
  private async markActive(id: string): Promise<void> {
    await this.patch(id, (entry) => ({ ...entry, state: 'running', lastActiveAt: new Date().toISOString() }));
    await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    if ((await this.storage.getAlarm()) === null)
      await this.storage.setAlarm(Date.now() + workspaceSettings(this.env).deleteAfterMs);
  }

  private async inspect(entry: WorkspaceEntry): Promise<State> {
    // After a provider switch this Worker can't reach the old sandbox, and an unreachable read would keep its slot.
    const live =
      entry.provider === this.env.WORKSPACE_BACKEND
        ? await Effect.runPromise(
            inspectWorkspace(this.env, entry.sandboxId).pipe(Effect.orElseSucceed((): State => 'unreachable')),
          )
        : 'deleted';

    this.checked.set(entry.id, { state: live, at: Date.now() });

    // An unreachable read says nothing about the sandbox.
    const believed = live === 'starting' ? 'running' : live;

    if ((believed === 'running' || believed === 'stopped' || believed === 'deleted') && believed !== entry.state)
      await this.setState(entry.id, believed);

    return live;
  }

  /** The state clients see. `fresh` skips the short-lived cache. */
  async state(entry: WorkspaceEntry, fresh: boolean): Promise<State> {
    if (entry.state === 'deleted') return 'deleted';

    if (this.resuming.has(entry.id)) return 'starting';
    const hit = this.checked.get(entry.id);

    if (!fresh && hit && Date.now() - hit.at < FRESH_MS) return hit.state;

    return this.inspect(entry);
  }

  /** Whether another sandbox may run. When the stored count says no, correct it against the provider before refusing. */
  private async hasRoom(except?: string): Promise<boolean> {
    if (!(await atCapacity(this.storage, this.env, except))) return true;
    const entries = await listWorkspaces(this.storage);

    // A sandbox being resumed may still read `stopped`; its resume sets the state when it is done.
    await Promise.all(
      entries
        .filter((entry) => entry.state === 'running' && !this.resuming.has(entry.id))
        .map((entry) => this.inspect(entry)),
    );

    return !(await atCapacity(this.storage, this.env, except));
  }

  /**
   * Runs an admission under the Catalog's gate, so parallel creations provision their sandboxes concurrently. A full
   * cap is corrected against the provider first, because the admission itself only counts stored state.
   */
  async admit<T>(admission: () => Promise<T>): Promise<T> {
    await this.hasRoom();

    return this.ctx.blockConcurrencyWhile(admission);
  }

  /** Makes sure an admitted sandbox exists and runs, and that the delete sweep will see it. */
  async ensure(creation: SessionCreation): Promise<WorkspaceEntry> {
    const workspace = await ensureWorkspace(this.storage, this.env, creation);
    await this.scheduleSweep();

    return workspace;
  }

  /** Start the session's sandbox if it is stopped. Concurrent callers share one resume. */
  resume(entry: WorkspaceEntry): Promise<ResumeResult> {
    return this.resuming.run(entry.id, () => this.startResume(entry));
  }

  private async startResume(entry: WorkspaceEntry): Promise<ResumeResult> {
    if (entry.state === 'deleted') return { ok: false, reason: 'expired' };
    const live = await this.inspect(entry);

    if (live === 'deleted') return { ok: false, reason: 'expired' };

    if (live === 'running') {
      await this.markActive(entry.id);

      return { ok: true };
    }

    if (live === 'stopped') {
      if (!(await this.hasRoom(entry.id))) return { ok: false, reason: 'limit' };

      // Count toward the cap while starting, so a second resume cannot overshoot it.
      await this.markActive(entry.id);
      const failed = await failure(resumeWorkspace(this.env, entry.sandboxId, workspaceSettings(this.env).ttlSeconds));

      if (failed?.reason === 'expired') {
        await this.setState(entry.id, 'deleted');

        return { ok: false, reason: 'expired' };
      }

      if (failed) {
        await this.setState(entry.id, 'stopped');

        return { ok: false, reason: 'unavailable' };
      }
    } else if (live !== 'starting') {
      return { ok: false, reason: 'unavailable' };
    }

    const after = await Effect.runPromise(
      waitForWorkspace(this.env, entry.sandboxId).pipe(Effect.orElseSucceed((): State => 'unreachable')),
    );

    this.checked.set(entry.id, { state: after, at: Date.now() });

    if (after === 'deleted') {
      await this.setState(entry.id, 'deleted');

      return { ok: false, reason: 'expired' };
    }

    if (after !== 'running') return { ok: false, reason: 'unavailable' };

    await this.scheduleSweep();

    return { ok: true };
  }

  /** A new, empty sandbox for a session whose sandbox was deleted. Retried messages share one replacement. */
  async replace(old: WorkspaceEntry): Promise<Replacement> {
    if (old.state !== 'deleted') throw new Error('Workspace is not deleted');

    return this.replacing.run(old.id, async () => {
      const admitted = await this.admit(() => admitReplacement(this.storage, this.env, old.sessionId, old.id));

      if (!admitted.ok) return admitted;

      try {
        const workspace = await this.ensure(admitted.creation);

        return { ok: true, workspaceId: workspace.id };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    });
  }

  /**
   * One keep-alive step. `active` pushes the auto-stop deadline out and counts as activity. `finished` shortens it
   * to IDLE_TTL_SECONDS so the sandbox stops soon after the run and frees its slot.
   * Returns the live state when the sandbox turns out to be stopped or deleted; any other failure throws for retry.
   * E2B pauses a sandbox at its plan's limit even mid-run, keeping its processes, so an active run resumes it instead
   * of renewing it.
   */
  async keepAlive(entry: WorkspaceEntry, mode: 'active' | 'finished'): Promise<State> {
    if (entry.state === 'deleted') return 'deleted';
    const active = mode === 'active';

    const failed = await failure(
      active
        ? resumeWorkspace(this.env, entry.sandboxId, workspaceSettings(this.env).ttlSeconds)
        : renewWorkspace(this.env, entry.sandboxId, IDLE_TTL_SECONDS),
    );

    if (failed) {
      const live = await this.inspect(entry);

      if (live === 'deleted' || (live === 'stopped' && !active)) return live;
      throw new Error('Keep-alive failed');
    }

    if (active) await this.markActive(entry.id);

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
