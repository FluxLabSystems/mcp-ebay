/**
 * How the Phase 2 tool surface costs the same deals routine.
 *
 * Every call count in the after ledger is produced here, from the catalog's
 * own constants, and never from a number chosen to make the diff look
 * good. The constants are passed in rather than imported so this module
 * stays pure arithmetic — the caller loads them out of the BUILT protocol
 * package (`packages/protocol/dist/`), which is the same copy the gateway
 * enforces with.
 *
 * The two rules that decide the item-page phase both live in
 * `packages/protocol/src/catalog.ts` and `packages/protocol/src/tools.ts`:
 *
 *   EXTRACT_MANY_MAX_URLS   how many URLs one browser_extract_many accepts
 *   MAX_INLINE_BATCH_ITEMS  the largest batch mode "auto" answers inline,
 *                           = floor((EXTRACT_MANY_TIMEOUT_MS -
 *                             BATCH_INLINE_RESERVE_MS) / BATCH_ITEM_BUDGET_MS)
 *
 * Today those are 25 and 2, so a 17-item batch is one call that PROMOTES TO
 * A JOB. A promoted call returns no result slots at all — it returns a
 * jobId — so the traversal is not paid for until browser_job_status is
 * polled, and any honest count of the after surface has to include the
 * polls. See JOB_POLLS_FLOOR for what this harness charges and why that is
 * a floor rather than a prediction.
 */

export interface BatchConstants {
  /** EXTRACT_MANY_MAX_URLS — URLs one browser_extract_many call may carry. */
  maxUrlsPerBatch: number;
  /** MAX_INLINE_BATCH_ITEMS — largest batch `mode:"auto"` answers inline. */
  maxInlineItems: number;
}

export interface BatchStep {
  /** URLs in this browser_extract_many call. */
  size: number;
  /** What `mode:"auto"` resolves to for a batch this size. */
  mode: 'inline' | 'job';
  /** browser_job_status calls charged to this step; 0 for an inline batch. */
  polls: number;
  /** The extract_many call plus its polls. */
  calls: number;
}

export interface BatchPlan {
  items: number;
  steps: BatchStep[];
  /** browser_extract_many calls. */
  batchCalls: number;
  /** browser_job_status calls. */
  pollCalls: number;
  /** Both together — what the item-page phase costs. */
  calls: number;
  /** calls / items, the figure the Phase 1 surface fixed at exactly 2. */
  callsPerItem: number;
}

/**
 * One poll per promoted job, and it is a FLOOR, not an estimate.
 *
 * A promoted browser_extract_many answers immediately with
 * `{mode:"job", status:"running", results:[]}` — apps/windows-agent/src/
 * executors.ts, executeExtractMany() — so at least one browser_job_status
 * is structurally required before the caller holds a single record. That
 * much is derivable from the tool surface.
 *
 * How many polls a real run actually makes is NOT derivable: it is the
 * job's wall-clock duration (17 live Chrome navigations on a paired
 * Windows box) divided by whatever cadence the caller polls at. Neither
 * number exists on this box, so the ledger charges the floor, labels it a
 * floor, and prints a sensitivity table beside it instead of picking a
 * plausible-looking multiple.
 */
export const JOB_POLLS_FLOOR = 1;

/** Poll counts the after report costs the routine at, beside the floor. */
export const POLL_SENSITIVITY = [1, 2, 4, 8] as const;

/**
 * Canonical item pages the routine opens. Seventeen is what the before
 * ledger replays, and the after ledger has to replay the same routine or
 * the two are not diffable.
 */
export const AFTER_ITEM_PAGES = 17;

/** Item counts the derivation is shown at, so the rule is visible, not asserted. */
export const ITEM_COUNT_SENSITIVITY = [17, 20, 25, 26, 40] as const;

/**
 * Split `items` URLs into browser_extract_many calls and say, for each,
 * whether `mode:"auto"` answers it inline or promotes it to a job.
 *
 * The split is the schema bound (`urls: z.array(z.url()).min(1).max(
 * EXTRACT_MANY_MAX_URLS)`) and the promotion test is the executor's, copied
 * from its one line: `input.urls.length <= MAX_INLINE_BATCH_ITEMS`.
 */
export function planBatches(
  items: number,
  constants: BatchConstants,
  pollsPerJob: number = JOB_POLLS_FLOOR,
): BatchPlan {
  if (items <= 0) {
    return { items: 0, steps: [], batchCalls: 0, pollCalls: 0, calls: 0, callsPerItem: 0 };
  }
  const steps: BatchStep[] = [];
  for (let taken = 0; taken < items; taken += constants.maxUrlsPerBatch) {
    const size = Math.min(constants.maxUrlsPerBatch, items - taken);
    const mode: 'inline' | 'job' = size <= constants.maxInlineItems ? 'inline' : 'job';
    const polls = mode === 'job' ? pollsPerJob : 0;
    steps.push({ size, mode, polls, calls: 1 + polls });
  }
  const batchCalls = steps.length;
  const pollCalls = steps.reduce((total, step) => total + step.polls, 0);
  const calls = batchCalls + pollCalls;
  return {
    items,
    steps,
    batchCalls,
    pollCalls,
    calls,
    callsPerItem: Number((calls / items).toFixed(3)),
  };
}

/**
 * What the Phase 1 surface charged for the same pages: one
 * browser_navigate and one browser_extract each, every time, with no batch
 * to amortise and no way to recover a dead page except more calls.
 */
export function phase1ItemPageCalls(items: number): number {
  return items * 2;
}

/**
 * Calls needed to read `rows` candidates through a window of `limit`.
 * DEFAULT_SEARCH_COMPACTION.limit is 40, so a 240-row page is one call for
 * the first 40 and six for all of them — which is the honest cost of the
 * default, and the reason the after ledger reports both.
 */
export function searchPagingCalls(rows: number, limit: number): number {
  if (rows <= 0 || limit <= 0) return 1;
  return Math.ceil(rows / limit);
}
