/**
 * Path: server/src/sessions/workspace-lifecycle.ts
 * Used by: server/src/sessions/catalog.ts.
 * Purpose: The catalog's view of each sandbox: admission and provisioning, believed state, live inspection, resume, replacement, keep-alive renewals and the delete sweep for idle and orphaned sandboxes.
 */

import type { Session } from '@cloud-swe/protocol';
import type { SessionCreation, WorkspaceEntry } from '@cloud-swe/protocol/storage';
import { Effect } from 'effect';
import { HTTPException } from 'hono/http-exception';

import type { Env } from '../env.ts';
import { logFault } from '../errors.ts';
import { WorkspaceError } from '../workspaces/errors.ts';
import {
  deleteWorkspace,
  inspectWorkspace,
  listSandboxes,
  renewWorkspace,
  resumeWorkspace,
  settle,
  waitForWorkspace,
} from '../workspaces/index.ts';
import { workspaceSettings } from '../workspaces/settings.ts';
import { catalogId, listWorkspaces, readWorkspace, writeWorkspace } from './catalog-store.ts';
import { admitReplacement, atCapacity, ensureWorkspace, type ReplacementRefusal } from './create.ts';
import { singleFlight } from './idempotency.ts';

type State = Session['workspace']['state'];

type ResumeResult = { ok: true } | { ok: false; reason: 'limit' | 'expired' | 'unavailable' };

type Replacement = { ok: true; workspaceId: WorkspaceEntry['id'] } | ReplacementRefusal;

// Reads reuse a live inspection this long, so listing many sessions is not one provider call each.
const FRESH_MS = 15_000;

// A failed delete is tried again after this long.
const DELETE_RETRY_MS = 60 * 60 * 1000;

/** Runs a workspace Effect and returns its failure instead of throwing. */
async function failure(effect: Effect.Effect<unknown, WorkspaceError>): Promise<WorkspaceError | undefined> {
  const result = await settle(effect);

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

  /** Applies a change to one stored entry atomically. A deleted entry never comes back. */
  private async patch(id: string, change: (entry: WorkspaceEntry) => WorkspaceEntry): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const current = await readWorkspace(tx, id);

      if (!current) throw new Error('Workspace not found');

      const next = change(current);

      if (current.state !== 'deleted' || next.state === 'deleted') await writeWorkspace(tx, next);
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
    // Even when this fails: the create may still have made a sandbox, which only the orphan sweep would delete.
    try {
      return await ensureWorkspace(this.storage, this.env, creation);
    } finally {
      await this.scheduleSweep();
    }
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
      } catch (error) {
        // A sandbox that is not ready yet is expected; anything else is a fault worth seeing.
        if (error instanceof Error && !(error instanceof HTTPException))
          logFault('Sandbox replacement failed', error, old.sessionId);

        return { ok: false, reason: 'unavailable' };
      }
    });
  }

  /**
   * One keep-alive step. `active` pushes the auto-stop deadline out and counts as activity. `finished` shortens it
   * to the idle TTL so the sandbox stops soon after the run and frees its slot.
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
        : renewWorkspace(this.env, entry.sandboxId, workspaceSettings(this.env).idleTtlSeconds),
    );

    if (failed) {
      const live = await this.inspect(entry);

      if (live === 'deleted' || (live === 'stopped' && !active)) return live;
      throw new Error('Keep-alive failed');
    }

    if (active) await this.markActive(entry.id);

    return 'running';
  }

  /** The alarm: delete sandboxes idle past the limit, then orphans, then wake again for the next one. */
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

    next = Math.min(next, await this.sweepOrphans(deleteAfterMs));

    if (next !== Infinity) await this.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  /**
   * Deletes this Catalog's sandboxes that no workspace entry points to, such as one whose create succeeded but whose
   * entry was never written. Only sandboxes stamped with this Catalog's ID are listed. One is left alone until it is as
   * old as the idle limit: a create in flight, or a retry that may still adopt its sandbox by metadata, is far younger.
   * Entries are never removed, so a sandbox the idle sweep is deleting or retrying still has its entry and is skipped
   * here. Returns when to look again.
   */
  private async sweepOrphans(minAgeMs: number): Promise<number> {
    const listed = await settle(listSandboxes(this.env, await catalogId(this.storage)));

    // A failed list deletes nothing, and is tried again later.
    if (listed instanceof WorkspaceError) {
      Effect.runSync(Effect.logWarning('Orphan sandbox list failed', listed.reason));

      return Date.now() + DELETE_RETRY_MS;
    }

    let next = Infinity;

    for (const { sandboxId, startedAt } of listed) {
      const due = startedAt + minAgeMs;

      if (due > Date.now()) {
        next = Math.min(next, due);
        continue;
      }

      // Read after listing, and again for each one: an entry written meanwhile claims its sandbox.
      if ((await listWorkspaces(this.storage)).some((entry) => entry.sandboxId === sandboxId)) continue;
      const failed = await failure(deleteWorkspace(this.env, sandboxId));

      if (failed) {
        Effect.runSync(Effect.logWarning('Orphan sandbox delete failed', sandboxId, failed.reason));
        next = Math.min(next, Date.now() + DELETE_RETRY_MS);
      } else Effect.runSync(Effect.logInfo('Orphan sandbox deleted', sandboxId));
    }

    return next;
  }
}
