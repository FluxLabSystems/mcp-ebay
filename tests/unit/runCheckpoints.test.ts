/**
 * Run checkpoints (Phase 4, root cause 5): the merge, the bounds and the
 * "resumable" rule, driven against MemoryStore. This is the implementation
 * every deployment without a DATABASE_URL actually runs, and the one the
 * integration suite exercises, so it is pinned here rather than left to the
 * PostgreSQL round-trip that CI skips on a clean checkout.
 */
import { describe, expect, it } from 'vitest';
import {
  RUN_CHECKPOINT_MAX_BYTES,
  RUN_CHECKPOINT_MAX_IDS,
  RUN_CHECKPOINT_MAX_SEARCHED,
  RUN_CHECKPOINT_TTL_SECONDS,
} from '@browser-bridge/protocol';
import { MemoryStore, RunCheckpointService } from '@browser-bridge/gateway';

const OWNER = 'user-1';

function build(): { service: RunCheckpointService; store: MemoryStore; advance: (seconds: number) => void } {
  const store = new MemoryStore();
  let clock = Date.parse('2026-08-29T09:00:00.000Z');
  const service = new RunCheckpointService({
    store: store.runCheckpoints,
    dashboard: 'deals',
    now: () => new Date(clock),
  });
  return { service, store, advance: (seconds) => (clock += seconds * 1000) };
}

describe('checkpoint merge semantics', () => {
  it('accumulates searched and verifiedIds so a turn sends only what it just learned', async () => {
    const { service } = build();
    await service.checkpoint(
      { runId: 'deals-2026-08-29', searched: ['ebay: lego bulk lot'], verifiedIds: ['ebay-1'] },
      OWNER,
    );
    const second = await service.checkpoint(
      // The second turn does not resend the first turn's findings — that is
      // the whole saving, and a union is what makes it safe.
      { runId: 'deals-2026-08-29', searched: ['kijiji: lego lot toronto'], verifiedIds: ['ebay-2'] },
      OWNER,
    );
    expect(second.searchedCount).toBe(2);
    expect(second.verifiedCount).toBe(2);
    expect(second.checkpointCount).toBe(2);

    const resumed = await service.resume('deals-2026-08-29', OWNER);
    expect(resumed.searched).toEqual(['ebay: lego bulk lot', 'kijiji: lego lot toronto']);
    expect(resumed.verifiedIds).toEqual(['ebay-1', 'ebay-2']);
  });

  it('re-reporting a verified id does not duplicate it', async () => {
    const { service } = build();
    await service.checkpoint({ runId: 'r', verifiedIds: ['ebay-1', 'ebay-2'] }, OWNER);
    const again = await service.checkpoint({ runId: 'r', verifiedIds: ['ebay-2', 'ebay-3'] }, OWNER);
    expect(again.verifiedCount).toBe(3);
    expect((await service.resume('r', OWNER)).verifiedIds).toEqual(['ebay-1', 'ebay-2', 'ebay-3']);
  });

  it('replaces pendingIds wholesale — a work queue that only grew could never empty', async () => {
    const { service } = build();
    await service.checkpoint({ runId: 'r', pendingIds: ['ebay-1', 'ebay-2', 'ebay-3'] }, OWNER);
    await service.checkpoint({ runId: 'r', pendingIds: ['ebay-3'], verifiedIds: ['ebay-1', 'ebay-2'] }, OWNER);
    const mid = await service.resume('r', OWNER);
    expect(mid.pendingIds).toEqual(['ebay-3']);

    const done = await service.checkpoint({ runId: 'r', pendingIds: [] }, OWNER);
    expect(done.pendingCount).toBe(0);
    expect(done.verifiedCount).toBe(2);
  });

  it('an omitted field leaves what is stored untouched', async () => {
    const { service } = build();
    await service.checkpoint(
      { runId: 'r', searched: ['q'], verifiedIds: ['ebay-1'], pendingIds: ['ebay-9'], notes: 'first pass' },
      OWNER,
    );
    await service.checkpoint({ runId: 'r' }, OWNER);
    const resumed = await service.resume('r', OWNER);
    expect(resumed.searched).toEqual(['q']);
    expect(resumed.verifiedIds).toEqual(['ebay-1']);
    expect(resumed.pendingIds).toEqual(['ebay-9']);
    expect(resumed.notes).toBe('first pass');
    expect(resumed.checkpointCount).toBe(2);
  });

  it('notes are replaced when sent and clearable with an empty string', async () => {
    const { service } = build();
    await service.checkpoint({ runId: 'r', notes: 'resume at page 3' }, OWNER);
    await service.checkpoint({ runId: 'r', notes: 'resume at page 7' }, OWNER);
    expect((await service.resume('r', OWNER)).notes).toBe('resume at page 7');
    await service.checkpoint({ runId: 'r', notes: '' }, OWNER);
    expect((await service.resume('r', OWNER)).notes).toBe('');
  });

  it('startedAt survives later checkpoints; updatedAt moves', async () => {
    const { service, advance } = build();
    await service.checkpoint({ runId: 'r' }, OWNER);
    const first = await service.resume('r', OWNER);
    advance(600);
    await service.checkpoint({ runId: 'r' }, OWNER);
    const second = await service.resume('r', OWNER);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    // A run stays resumable for the TTL measured from its last write.
    expect(Date.parse(second.expiresAt!) - Date.parse(second.updatedAt!)).toBe(RUN_CHECKPOINT_TTL_SECONDS * 1000);
  });
});

describe('status transitions', () => {
  it('a new run with no status starts running', async () => {
    const { service } = build();
    expect((await service.checkpoint({ runId: 'r' }, OWNER)).status).toBe('running');
  });

  it('an omitted status never resurrects a completed run', async () => {
    const { service } = build();
    await service.checkpoint({ runId: 'r', status: 'completed' }, OWNER);
    // This is why the schema leaves status optional instead of defaulting
    // it: a default of 'running' would silently reopen a finished run on
    // the next bookkeeping write.
    const after = await service.checkpoint({ runId: 'r', verifiedIds: ['ebay-1'] }, OWNER);
    expect(after.status).toBe('completed');
  });
});

describe('payload bounds', () => {
  it('caps each list and reports what it dropped instead of dropping it silently', async () => {
    const { service } = build();
    for (let batch = 0; batch < 2; batch++) {
      await service.checkpoint(
        {
          runId: 'r',
          searched: Array.from({ length: RUN_CHECKPOINT_MAX_SEARCHED }, (_, i) => `q-${batch}-${i}`),
        },
        OWNER,
      );
    }
    const result = await service.checkpoint({ runId: 'r', searched: ['q-final'] }, OWNER);
    expect(result.searchedCount).toBe(RUN_CHECKPOINT_MAX_SEARCHED);
    expect(result.warnings.join(' ')).toContain('searched trimmed');
    const resumed = await service.resume('r', OWNER);
    // Oldest go first, and the newest entry is always kept.
    expect(resumed.searched).toContain('q-final');
    expect(resumed.searched).not.toContain('q-0-0');
  });

  it('keeps the stored payload under the byte ceiling by dropping the oldest of the longest list', async () => {
    const { service } = build();
    const fat = Array.from({ length: RUN_CHECKPOINT_MAX_IDS }, (_, i) => `ebay-${String(i).padStart(114, '0')}`);
    const result = await service.checkpoint({ runId: 'r', verifiedIds: fat }, OWNER);
    expect(result.storedBytes).toBeLessThanOrEqual(RUN_CHECKPOINT_MAX_BYTES);
    expect(result.verifiedCount).toBeLessThan(RUN_CHECKPOINT_MAX_IDS);
    expect(result.warnings.join(' ')).toContain('payload trimmed');
    const resumed = await service.resume('r', OWNER);
    // Trimming is oldest-first, so the most recent evidence survives.
    expect(resumed.verifiedIds.at(-1)).toBe(fat.at(-1));
  });

  it('an ordinary run stays far inside the ceiling and warns about nothing', async () => {
    const { service } = build();
    const result = await service.checkpoint(
      {
        runId: 'r',
        searched: ['ebay: lego bulk lot', 'kijiji: lego lot toronto'],
        verifiedIds: Array.from({ length: 40 }, (_, i) => `ebay-2261234567${String(i).padStart(2, '0')}`),
        pendingIds: Array.from({ length: 20 }, (_, i) => `kijiji-17409402${String(i).padStart(2, '0')}`),
        notes: 'page 2 of 5 on Track A',
      },
      OWNER,
    );
    expect(result.warnings).toEqual([]);
    expect(result.storedBytes).toBeLessThan(RUN_CHECKPOINT_MAX_BYTES / 2);
  });
});

describe('resume', () => {
  it('with no runId returns the most recently updated running run', async () => {
    const { service, advance } = build();
    await service.checkpoint({ runId: 'older', verifiedIds: ['ebay-1'] }, OWNER);
    advance(60);
    await service.checkpoint({ runId: 'newer', verifiedIds: ['ebay-2'] }, OWNER);
    const latest = await service.resume(undefined, OWNER);
    expect(latest.found).toBe(true);
    expect(latest.runId).toBe('newer');
    expect(latest.resumable).toBe(true);
    expect(latest.ageSeconds).toBe(0);
  });

  it('skips completed and abandoned runs when picking the latest', async () => {
    const { service, advance } = build();
    await service.checkpoint({ runId: 'still-going' }, OWNER);
    advance(60);
    await service.checkpoint({ runId: 'finished', status: 'completed' }, OWNER);
    advance(60);
    await service.checkpoint({ runId: 'given-up', status: 'abandoned' }, OWNER);
    expect((await service.resume(undefined, OWNER)).runId).toBe('still-going');
  });

  it('a named completed run reads back as found but not resumable', async () => {
    const { service } = build();
    await service.checkpoint({ runId: 'r', verifiedIds: ['ebay-1'], status: 'completed' }, OWNER);
    const resumed = await service.resume('r', OWNER);
    // "Already finished" and "never existed" are different answers, and a
    // caller that asked for a specific run deserves the accurate one.
    expect(resumed.found).toBe(true);
    expect(resumed.resumable).toBe(false);
    expect(resumed.verifiedIds).toEqual(['ebay-1']);
    expect(resumed.warnings.join(' ')).toContain('already completed');
  });

  it('says so rather than staying silent when there is nothing to resume', async () => {
    const { service } = build();
    const empty = await service.resume(undefined, OWNER);
    expect(empty.found).toBe(false);
    expect(empty.resumable).toBe(false);
    expect(empty.verifiedIds).toEqual([]);
    expect(empty.warnings).toHaveLength(1);
    expect(empty.warnings[0]).toContain('No resumable deals run');

    const missing = await service.resume('never-written', OWNER);
    expect(missing.found).toBe(false);
    expect(missing.warnings[0]).toContain('never-written');
  });

  it('a checkpoint past its TTL is gone, by id and by latest lookup', async () => {
    const { service, advance } = build();
    await service.checkpoint({ runId: 'r', verifiedIds: ['ebay-1'] }, OWNER);
    advance(RUN_CHECKPOINT_TTL_SECONDS - 60);
    expect((await service.resume('r', OWNER)).found).toBe(true);
    advance(120);
    // Resuming yesterday's prices as today's evidence is worse than
    // re-searching, so an expired run is absent, not stale-but-offered.
    expect((await service.resume('r', OWNER)).found).toBe(false);
    expect((await service.resume(undefined, OWNER)).found).toBe(false);
  });

  it('reusing the id of an expired run starts a fresh run, not a continuation', async () => {
    const { service, advance } = build();
    await service.checkpoint({ runId: 'deals-daily', verifiedIds: ['ebay-1'], notes: 'yesterday' }, OWNER);
    advance(RUN_CHECKPOINT_TTL_SECONDS + 1);
    const reused = await service.checkpoint({ runId: 'deals-daily', verifiedIds: ['ebay-2'] }, OWNER);
    // The expired run is absent to every read, so nothing of it survives
    // into the new one — the count restarts and yesterday's ids are gone.
    expect(reused.checkpointCount).toBe(1);
    expect(reused.verifiedCount).toBe(1);
    const resumed = await service.resume('deals-daily', OWNER);
    expect(resumed.verifiedIds).toEqual(['ebay-2']);
    expect(resumed.notes).toBeNull();
    expect(resumed.startedAt).toBe(resumed.updatedAt);
  });

  it('the sweeper deletes what reads already treated as absent', async () => {
    const { service, store, advance } = build();
    await service.checkpoint({ runId: 'r' }, OWNER);
    advance(RUN_CHECKPOINT_TTL_SECONDS + 1);
    expect(store.runCheckpoints.rows.size).toBe(1);
    expect(await store.runCheckpoints.purgeExpired(new Date(Date.parse('2026-08-30T09:00:01.000Z')))).toBe(1);
    expect(store.runCheckpoints.rows.size).toBe(0);
  });
});

describe('run ownership', () => {
  it('one caller cannot read or overwrite another caller\'s run', async () => {
    const { service } = build();
    await service.checkpoint({ runId: 'r', verifiedIds: ['ebay-1'] }, OWNER);

    const other = await service.resume('r', 'user-2');
    expect(other.found).toBe(false);
    expect((await service.resume(undefined, 'user-2')).found).toBe(false);

    await expect(service.checkpoint({ runId: 'r', verifiedIds: ['ebay-9'] }, 'user-2')).rejects.toMatchObject({
      code: 'ACTION_BLOCKED',
    });
    // The refused write left the owner's checkpoint intact.
    expect((await service.resume('r', OWNER)).verifiedIds).toEqual(['ebay-1']);
  });

  it('a null subject (OAuth disabled) is an owner like any other', async () => {
    const { service } = build();
    await service.checkpoint({ runId: 'r', verifiedIds: ['ebay-1'] }, null);
    expect((await service.resume(undefined, null)).runId).toBe('r');
    expect((await service.resume(undefined, OWNER)).found).toBe(false);
  });
});
