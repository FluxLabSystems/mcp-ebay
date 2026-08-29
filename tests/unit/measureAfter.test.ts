/**
 * The facts `tools/measure/after.ts` derives its call counts from.
 *
 * The after ledger does not choose a number for the item-page phase: it
 * asks the catalog how big a batch may be, whether a batch of that size is
 * answered inline or promoted to a job, and whether a promoted call hands
 * back any records. Those three answers are what make "17 item pages cost 2
 * calls" a derivation rather than an assertion, and every one of them can
 * change without touching the harness — which would leave the committed
 * after-ledger.json quietly describing a tool surface that no longer
 * exists.
 *
 * So they are pinned here. A failure in this file does not mean the ledger
 * is wrong; it means the ledger needs re-capturing and its item-page story
 * needs re-reading.
 *
 * Deliberately no import from tools/: that tree sits outside the pnpm
 * workspace and is not part of this package's typecheck program. What is
 * pinned is the SOURCE of the harness's numbers, in the packages it reads
 * them out of.
 */
import { describe, expect, it } from 'vitest';
import {
  BATCH_INLINE_RESERVE_MS,
  BATCH_ITEM_BUDGET_MS,
  BATCH_JOB_DEADLINE_MS,
  DEFAULT_SEARCH_COMPACTION,
  EXTRACT_MANY_MAX_URLS,
  EXTRACT_MANY_TIMEOUT_MS,
  MAX_INLINE_BATCH_ITEMS,
} from '@browser-bridge/protocol';
import { BatchJobStore, jobProgress } from '@browser-bridge/windows-agent';

/** Canonical item pages the before and after ledgers both replay. */
const LEDGER_ITEM_PAGES = 17;

/**
 * The harness's batch split, restated. Kept a few lines long and local so
 * this file pins the RULE rather than importing the implementation of it.
 */
function batchSizes(items: number, maxUrls: number): number[] {
  const sizes: number[] = [];
  for (let taken = 0; taken < items; taken += maxUrls) {
    sizes.push(Math.min(maxUrls, items - taken));
  }
  return sizes;
}

describe('after-ledger derivation: the promotion rule', () => {
  it('MAX_INLINE_BATCH_ITEMS is the catalog arithmetic, not a literal', () => {
    expect(MAX_INLINE_BATCH_ITEMS).toBe(
      Math.max(1, Math.floor((EXTRACT_MANY_TIMEOUT_MS - BATCH_INLINE_RESERVE_MS) / BATCH_ITEM_BUDGET_MS)),
    );
    // The value the committed after ledger was captured against. If this
    // moves, the item-page phase changes shape: a larger inline batch
    // deletes the browser.job_status poll the ledger currently charges.
    expect(MAX_INLINE_BATCH_ITEMS).toBe(2);
  });

  it('a 17-page traversal is one batch, and that batch promotes to a job', () => {
    expect(batchSizes(LEDGER_ITEM_PAGES, EXTRACT_MANY_MAX_URLS)).toEqual([LEDGER_ITEM_PAGES]);
    expect(LEDGER_ITEM_PAGES).toBeGreaterThan(MAX_INLINE_BATCH_ITEMS);
  });

  it('the batch split follows EXTRACT_MANY_MAX_URLS across the range the ledger reports', () => {
    expect(EXTRACT_MANY_MAX_URLS).toBe(25);
    expect(batchSizes(20, EXTRACT_MANY_MAX_URLS)).toEqual([20]);
    expect(batchSizes(25, EXTRACT_MANY_MAX_URLS)).toEqual([25]);
    expect(batchSizes(26, EXTRACT_MANY_MAX_URLS)).toEqual([25, 1]);
    expect(batchSizes(40, EXTRACT_MANY_MAX_URLS)).toEqual([25, 15]);
    // 26 splits into a job plus an inline remainder, which is the only row
    // in the ledger's sensitivity table where the two modes both appear.
    expect(1).toBeLessThanOrEqual(MAX_INLINE_BATCH_ITEMS);
  });

  it('a promoted job is bounded by the same per-item charge the promotion used', () => {
    expect(BATCH_JOB_DEADLINE_MS).toBe(EXTRACT_MANY_MAX_URLS * BATCH_ITEM_BUDGET_MS);
  });
});

describe('after-ledger derivation: why a poll is structural', () => {
  it('the call that starts a promoted batch returns no result slots at all', () => {
    const store = new BatchJobStore({ retentionMs: 60_000 });
    const job = store.create('bs_test', LEDGER_ITEM_PAGES, true);
    const accepted = jobProgress(job);

    expect(accepted.mode).toBe('job');
    expect(accepted.status).toBe('running');
    expect(accepted.requested).toBe(LEDGER_ITEM_PAGES);
    expect(accepted.completed).toBe(0);
    // The whole reason the after ledger charges at least one
    // browser.job_status: without it the caller holds a jobId and nothing.
    expect(accepted.results).toEqual([]);
    expect(typeof accepted.jobId).toBe('string');
  });

  it('sinceIndex is what keeps an extra poll cheap rather than free', () => {
    const store = new BatchJobStore({ retentionMs: 60_000 });
    const job = store.create('bs_test', 3, true);
    for (let index = 0; index < 3; index += 1) {
      store.append(job.jobId, {
        url: `https://www.ebay.ca/itm/22610000000${index}`,
        finalUrl: `https://www.ebay.ca/itm/22610000000${index}`,
        ok: true,
        siteProfile: 'ebay.ca.v1',
        pageRevision: index,
        record: { itemId: `22610000000${index}` },
        warnings: [],
        error: null,
      });
    }
    store.finish(job.jobId, 'completed');

    const first = jobProgress(job, 0);
    expect((first.results as unknown[]).length).toBe(3);

    // A poll that has already read everything still costs its progress
    // envelope, and never re-sends a slot. Both halves matter to the
    // ledger: the first is the marginal price of over-polling, the second
    // is why over-polling does not multiply the payload.
    const again = jobProgress(job, 3);
    expect(again.resultsFrom).toBe(3);
    expect(again.results).toEqual([]);
    expect(again.completed).toBe(3);
  });
});

describe('after-ledger derivation: the search window', () => {
  it('the default compaction returns a 40-row window with canonical URLs', () => {
    expect(DEFAULT_SEARCH_COMPACTION.limit).toBe(40);
    expect(DEFAULT_SEARCH_COMPACTION.offset).toBe(0);
    expect(DEFAULT_SEARCH_COMPACTION.canonicalizeUrls).toBe(true);
  });

  it('so one call is 40 of a 240-row page, and all of it is six', () => {
    // The ledger reports both, because the one-call figure is a smaller
    // answer as well as a smaller payload and the diff would flatter
    // itself if only the first number appeared.
    expect(Math.ceil(240 / DEFAULT_SEARCH_COMPACTION.limit)).toBe(6);
  });
});
