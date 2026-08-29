/**
 * Deals run checkpoints — Phase 4, root cause 5 of the deals-run budget
 * audit. A scheduled run used to lose everything it had learned the moment
 * it hit the per-turn tool-call ceiling: audit_events records that calls
 * happened, not what a run concluded, and there was no run entity at all.
 * These two operations give a run one small durable row.
 *
 * The merge, the bounds and the "resumable" rule live here rather than in
 * either Store implementation, so the in-memory and PostgreSQL paths cannot
 * drift apart on the semantics a resume depends on. The stores below this
 * layer do row CRUD and nothing else.
 */
import {
  BridgeError,
  RUN_CHECKPOINT_MAX_BYTES,
  RUN_CHECKPOINT_MAX_IDS,
  RUN_CHECKPOINT_MAX_SEARCHED,
  RUN_CHECKPOINT_TTL_SECONDS,
  type DashboardId,
} from '@browser-bridge/protocol';
import type { RunCheckpointRow, RunCheckpointStore } from '../store/types.js';

export interface RunCheckpointWrite {
  runId: string;
  searched?: string[];
  verifiedIds?: string[];
  pendingIds?: string[];
  notes?: string;
  status?: RunCheckpointRow['status'];
}

export interface RunCheckpointResult {
  runId: string;
  dashboard: string;
  status: RunCheckpointRow['status'];
  checkpointCount: number;
  searchedCount: number;
  verifiedCount: number;
  pendingCount: number;
  storedBytes: number;
  updatedAt: string;
  expiresAt: string;
  warnings: string[];
}

export interface RunResumeResult {
  found: boolean;
  resumable: boolean;
  runId: string | null;
  dashboard: string;
  status: RunCheckpointRow['status'] | null;
  searched: string[];
  verifiedIds: string[];
  pendingIds: string[];
  notes: string | null;
  checkpointCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  ageSeconds: number | null;
  warnings: string[];
}

interface StoredPayload {
  searched: string[];
  verifiedIds: string[];
  pendingIds: string[];
  notes: string | null;
}

/** Exactly what the bound is measured against: the payload, as stored. */
function payloadBytes(payload: StoredPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/** Union preserving first-seen order — oldest entries stay at the front. */
function union(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const entry of incoming) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

type ListName = 'verifiedIds' | 'pendingIds' | 'searched';

/**
 * Order used to break ties when two lists are the same length and one has
 * to give. searched is last because it is the cheapest thing to lose: a
 * forgotten query costs one re-search, a forgotten verified id costs a
 * re-verification, and a forgotten pending id costs an item that never gets
 * looked at at all.
 */
const DROP_ORDER: readonly ListName[] = ['verifiedIds', 'pendingIds', 'searched'];

const COUNT_CAPS: Readonly<Record<ListName, number>> = {
  verifiedIds: RUN_CHECKPOINT_MAX_IDS,
  pendingIds: RUN_CHECKPOINT_MAX_IDS,
  searched: RUN_CHECKPOINT_MAX_SEARCHED,
};

/**
 * Bring a merged payload inside both bounds, oldest entries first, and say
 * what it cost. Trimming rather than refusing is deliberate: a checkpoint
 * that is rejected for being one id too large leaves the run with the
 * *older* checkpoint, which is strictly worse than one that dropped its
 * oldest ids and said so.
 */
function trimToBounds(payload: StoredPayload): { payload: StoredPayload; bytes: number; warnings: string[] } {
  const warnings: string[] = [];
  const lists: Record<ListName, string[]> = {
    verifiedIds: [...payload.verifiedIds],
    pendingIds: [...payload.pendingIds],
    searched: [...payload.searched],
  };

  for (const name of DROP_ORDER) {
    const overflow = lists[name].length - COUNT_CAPS[name];
    if (overflow > 0) {
      lists[name] = lists[name].slice(overflow);
      warnings.push(`${name} trimmed to the newest ${COUNT_CAPS[name]} entries (${overflow} oldest dropped)`);
    }
  }

  const shaped = (): StoredPayload => ({
    searched: lists.searched,
    verifiedIds: lists.verifiedIds,
    pendingIds: lists.pendingIds,
    notes: payload.notes,
  });

  let bytes = payloadBytes(shaped());
  let droppedForBytes = 0;
  while (bytes > RUN_CHECKPOINT_MAX_BYTES) {
    // Drop from whichever list is longest — the one actually responsible
    // for the overflow — and use DROP_ORDER only to break ties.
    let target: ListName | null = null;
    for (const name of DROP_ORDER) {
      if (lists[name].length === 0) continue;
      if (target === null || lists[name].length > lists[target].length) target = name;
    }
    if (target === null) break; // Nothing left to give; notes alone is over.
    lists[target] = lists[target].slice(1);
    droppedForBytes += 1;
    bytes = payloadBytes(shaped());
  }
  if (droppedForBytes > 0) {
    warnings.push(
      `payload trimmed to ${RUN_CHECKPOINT_MAX_BYTES} bytes: ${droppedForBytes} oldest entries dropped`,
    );
  }

  return { payload: shaped(), bytes, warnings };
}

export interface RunCheckpointServiceOptions {
  store: RunCheckpointStore;
  dashboard: DashboardId;
  /** Overridable for tests; production uses the protocol constant. */
  ttlSeconds?: number;
  now?: () => Date;
}

export class RunCheckpointService {
  private readonly store: RunCheckpointStore;
  private readonly dashboard: DashboardId;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(options: RunCheckpointServiceOptions) {
    this.store = options.store;
    this.dashboard = options.dashboard;
    this.ttlSeconds = options.ttlSeconds ?? RUN_CHECKPOINT_TTL_SECONDS;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Read-modify-write. Not serialized against a concurrent writer, and it
   * does not need to be: a run is one model driving one turn at a time, and
   * two checkpoints racing on the same runId would be two turns of the same
   * run, which is not a shape this tool is asked to survive.
   */
  async checkpoint(input: RunCheckpointWrite, ownerSubject: string | null): Promise<RunCheckpointResult> {
    const now = this.now();
    const existing = await this.store.get(input.runId, now);
    if (existing !== null && existing.ownerSubject !== ownerSubject) {
      // Not "not found": the row exists and is someone else's. Saying so
      // without naming the owner is enough for the caller to pick a
      // different runId.
      throw new BridgeError('ACTION_BLOCKED', `Run ${input.runId} belongs to another caller.`, {
        runId: input.runId,
      });
    }
    if (existing !== null && existing.dashboard !== this.dashboard) {
      throw new BridgeError(
        'ACTION_BLOCKED',
        `Run ${input.runId} already exists for the "${existing.dashboard}" dashboard.`,
        { runId: input.runId, dashboard: existing.dashboard },
      );
    }

    const merged: StoredPayload = {
      // searched and verifiedIds accumulate: both record facts that stay
      // true, so a later checkpoint can only add to them.
      searched: union(existing?.searched ?? [], input.searched ?? []),
      verifiedIds: union(existing?.verifiedIds ?? [], input.verifiedIds ?? []),
      // pendingIds is the outstanding work queue and is replaced wholesale;
      // a union could never reach empty and the run could never finish.
      pendingIds: input.pendingIds === undefined ? (existing?.pendingIds ?? []) : [...input.pendingIds],
      notes: input.notes === undefined ? (existing?.notes ?? null) : input.notes,
    };
    const trimmed = trimToBounds(merged);

    const row: RunCheckpointRow = {
      runId: input.runId,
      dashboard: this.dashboard,
      ownerSubject,
      // An omitted status leaves an existing run's status alone; a new run
      // with no status starts 'running'. Defaulting to 'running' in the
      // schema would silently reopen a run already marked complete.
      status: input.status ?? existing?.status ?? 'running',
      searched: trimmed.payload.searched,
      verifiedIds: trimmed.payload.verifiedIds,
      pendingIds: trimmed.payload.pendingIds,
      notes: trimmed.payload.notes,
      checkpointCount: (existing?.checkpointCount ?? 0) + 1,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      // The TTL runs from the last write, so an active run stays resumable
      // for as long as it keeps checkpointing.
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000),
    };
    await this.store.put(row);

    return {
      runId: row.runId,
      dashboard: row.dashboard,
      status: row.status,
      checkpointCount: row.checkpointCount,
      searchedCount: row.searched.length,
      verifiedCount: row.verifiedIds.length,
      pendingCount: row.pendingIds.length,
      storedBytes: trimmed.bytes,
      updatedAt: row.updatedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      warnings: trimmed.warnings,
    };
  }

  /**
   * "Resumable" is: status 'running', and last checkpointed inside the TTL.
   * A named runId is read whatever its status — a caller that asks for a
   * specific run deserves to be told it already finished rather than that
   * it does not exist. An expired run is absent either way; its row is gone
   * or on its way out, and reporting stale state as resumable would be the
   * worse failure.
   */
  async resume(runId: string | undefined, ownerSubject: string | null): Promise<RunResumeResult> {
    const now = this.now();
    const row =
      runId === undefined
        ? await this.store.latestResumable(this.dashboard, ownerSubject, now)
        : await this.store.get(runId, now);

    // A run owned by someone else reads as absent rather than as refused.
    // The write path does say "belongs to another caller", and the
    // asymmetry is deliberate: a writer has to know the id is taken to pick
    // another one, while a reader learns nothing useful from the
    // difference and would only be learning that someone else's run exists.
    if (row === null || (runId !== undefined && row.ownerSubject !== ownerSubject)) {
      return {
        found: false,
        resumable: false,
        runId: runId ?? null,
        dashboard: this.dashboard,
        status: null,
        searched: [],
        verifiedIds: [],
        pendingIds: [],
        notes: null,
        checkpointCount: 0,
        startedAt: null,
        updatedAt: null,
        expiresAt: null,
        ageSeconds: null,
        warnings: [
          runId === undefined
            ? `No resumable ${this.dashboard} run: none checkpointed as running within the last ${Math.round(
                this.ttlSeconds / 3600,
              )} h. Start a new run.`
            : `Run ${runId} is unknown or its checkpoint has expired (${Math.round(
                this.ttlSeconds / 3600,
              )} h retention). Start a new run.`,
        ],
      };
    }

    return {
      found: true,
      resumable: row.status === 'running',
      runId: row.runId,
      dashboard: row.dashboard,
      status: row.status,
      searched: row.searched,
      verifiedIds: row.verifiedIds,
      pendingIds: row.pendingIds,
      notes: row.notes,
      checkpointCount: row.checkpointCount,
      startedAt: row.startedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      ageSeconds: Math.max(0, Math.floor((now.getTime() - row.updatedAt.getTime()) / 1000)),
      warnings:
        row.status === 'running'
          ? []
          : [`Run ${row.runId} is already ${row.status}; it is readable but not resumable.`],
    };
  }
}
