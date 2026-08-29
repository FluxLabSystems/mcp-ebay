#!/usr/bin/env node
/**
 * Deals-routine call-budget ledger — the "after" capture, and the diff.
 *
 * Run:  node tools/measure/after.ts   [--out <path>] [--offline] [--before <path>]
 *  or:  node tools/measure/ledger.ts --after   (same thing; ledger.ts dispatches)
 *
 * Replays THE SAME routine `ledger.ts` replays — feed, session open, one
 * 240-row eBay search page, seventeen canonical item pages, one upsert —
 * costed against the Phase 2 tool surface (browser.open_and_extract,
 * browser.extract_many, browser.job_status, server-side search compaction,
 * dashboard.feed filter/fields, dashboard.upsert touch), and prints the
 * before → after diff.
 *
 * Three rules this file exists to obey:
 *
 *   1. Call counts are DERIVED, never chosen. Every one of them comes out
 *      of afterModel.ts, which is handed the constants from the BUILT
 *      protocol package. A 17-item batch promotes to a job because
 *      MAX_INLINE_BATCH_ITEMS says 2, and the poll that promotion forces is
 *      counted — see JOB_POLLS_FLOOR, and the sensitivity table this prints
 *      beside it.
 *   2. The "before" side is not retyped from the committed baseline. It is
 *      produced by running ledger.ts itself, in a subprocess, against this
 *      same tree and this same Node — so the two sides differ by the tool
 *      surface and nothing else. The committed baseline-ledger.json is read
 *      too, and any drift from it is reported rather than smoothed over.
 *      Neither path writes to the committed baseline.
 *   3. Bytes are measured where they can be measured (the real compactor,
 *      the real job store, the real dashboard client, over the checked-in
 *      fixtures and over the SAME constructed 240-row page srpModel.ts
 *      builds for the before capture), modelled where the input had to be
 *      constructed, and null-with-a-reason where this box cannot answer at
 *      all. www.ebay.ca still answers 403 here; there is still no Chrome
 *      and no paired Windows agent.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../../tests/helpers/fixtureServer.ts';
import {
  REPORTED_FEED_BYTES,
  REPORTED_FEED_RECORD_COUNT,
  MODELLED_ITMPRP_LENGTH,
  MODELLED_ROWS_PER_PAGE,
  MODELLED_TITLE_LENGTH,
  REPO_ROOT,
  buildSearchResultsPage,
  fixture,
  itemExtractEnvelope,
  jsonBytes,
  kib,
  loadBuilt,
  loadParseHtml,
  modelDealsFeed,
  probeReachability,
  searchExtractRecord,
  sourceState,
  table,
  timed,
  type Basis,
  type Probe,
} from './probes.ts';
import {
  AFTER_ITEM_PAGES,
  ITEM_COUNT_SENSITIVITY,
  JOB_POLLS_FLOOR,
  POLL_SENSITIVITY,
  phase1ItemPageCalls,
  planBatches,
  searchPagingCalls,
  type BatchConstants,
} from './afterModel.ts';

/* ------------------------------------------------------------------------ *
 * Built-module shapes. Loaded by path from dist/ for the same reason the
 * before harness does it: this has to measure what the gateway and the
 * agent actually ship, not a second copy compiled for the occasion.
 * ------------------------------------------------------------------------ */

interface EbayModule {
  extractListingCandidates: (document: Document, pageUrl: string) => unknown[];
  extractListing: (
    document: Document,
    pageUrl: string,
    context?: Record<string, unknown>,
  ) => { record: Record<string, unknown>; warnings: string[] };
}
interface KijijiModule {
  extractSearchResults: (
    document: Document,
    pageUrl: string,
  ) => { results: unknown[]; hasNextPage?: boolean; nextPageUrl?: string | null; totalResults?: number | null };
  extractKijijiListing: (
    document: Document,
    pageUrl: string,
    context?: Record<string, unknown>,
  ) => { record: Record<string, unknown>; warnings: string[] };
}

interface SearchCompactionLike {
  limit: number;
  offset: number;
  canonicalizeUrls: boolean;
  fields?: string[];
  include?: Record<string, unknown>;
}

interface ProtocolModule {
  /** catalog.ts */
  MAX_INLINE_BATCH_ITEMS: number;
  BATCH_ITEM_BUDGET_MS: number;
  BATCH_INLINE_RESERVE_MS: number;
  EXTRACT_MANY_TIMEOUT_MS: number;
  BATCH_JOB_DEADLINE_MS: number;
  /** tools.ts */
  EXTRACT_MANY_MAX_URLS: number;
  DEFAULT_SEARCH_COMPACTION: SearchCompactionLike;
  SearchCompactionInput: { parse: (value: unknown) => SearchCompactionLike };
}

interface CompactModule {
  compactSearchPage: (
    record: unknown,
    options: SearchCompactionLike,
  ) => { record: Record<string, unknown>; warnings: string[] };
  compactItemRecord: (
    siteProfile: string | null,
    record: unknown,
    warnings?: readonly string[],
  ) => Record<string, unknown>;
}

interface BatchJobLike {
  jobId: string;
  requested: number;
  results: unknown[];
}
interface JobsModule {
  BatchJobStore: new (options: { retentionMs: number }) => {
    create: (handle: string, requested: number, compact: boolean, warnings?: string[]) => BatchJobLike;
    append: (jobId: string, item: unknown) => void;
    finish: (jobId: string, status: 'completed' | 'partial', warnings?: string[]) => void;
  };
  jobProgress: (job: BatchJobLike, sinceIndex?: number) => Record<string, unknown>;
}

interface FeedOptions {
  filter?: { active?: boolean; status?: readonly string[]; marketplace?: string };
  fields?: readonly string[];
}
interface DashboardModule {
  DashboardClient: new (options: {
    baseUrl: string;
    tokens: Record<string, string>;
    fetchImpl: typeof fetch;
  }) => {
    feed: (
      dashboard: string,
      mode: 'full' | 'ids',
      options?: FeedOptions,
    ) => Promise<{ listingCount: number; totalListingCount: number; root: Record<string, unknown> }>;
    upsert: (
      dashboard: string,
      listings?: Record<string, unknown>[],
      touch?: readonly { id: string; lastSeen: string }[],
    ) => Promise<{ ok: boolean; summary: Record<string, unknown>; result: Record<string, unknown> }>;
  };
}

interface TelemetryModule {
  createCallRecorder: (options: Record<string, unknown>) => {
    logPath: string | null;
    record: (observation: Record<string, unknown>) => void;
    close: () => Promise<void>;
  };
}

/* ------------------------------------------------------------------------ */

interface SimulatedCall {
  phase: string;
  toolName: string;
  args: unknown;
  response: unknown;
  durationMs: number;
}

interface LedgerRow {
  phase: string;
  calls: number | null;
  bytes: number | null;
  seconds: number | null;
  basis: Basis;
  note: string;
}

interface Unmeasurable {
  id: string;
  reason: string;
  origin?: 'carried' | 'after';
}

const PHASES = ['preamble', 'search_page', 'item_pages', 'upsert'] as const;
const PHASE_LABEL: Record<string, string> = {
  preamble: 'Preamble (feed + session_open)',
  search_page: 'One eBay search page',
  item_pages: '17 canonical item pages',
  upsert: 'dashboard.upsert',
};

const SESSION_HANDLE = 'bs_0000000000000000';

/**
 * The per-listing fields a deals run needs from the stored feed to decide
 * "already have it, unchanged, and at the same landed price". `id` is
 * retained by DashboardClient whether or not it is asked for.
 */
const AFTER_FEED_FIELDS = ['lastSeen', 'status', 'landedCad'] as const;

/** Records the after upsert refreshes with `touch` rather than re-sending whole. */
const AFTER_TOUCH_COUNT = AFTER_ITEM_PAGES - 6;

/**
 * What the after capture still cannot answer. The first group is carried
 * verbatim out of the before capture — every one of them is still true, and
 * copying the text by hand is how two ledgers stop agreeing. The second
 * group is new, and every entry in it is a place where the after story
 * would look better if a number were invented here.
 */
const AFTER_UNMEASURABLE: Unmeasurable[] = [
  {
    id: 'batch.job_poll_count',
    origin: 'after',
    reason:
      'A 17-URL batch promotes to a job (MAX_INLINE_BATCH_ITEMS is 2), and how many browser.job_status polls a real run spends is the job\'s wall-clock duration — 17 live Chrome navigations — divided by the caller\'s polling cadence. Neither exists on this box. The ledger charges the structural floor of 1 poll and prints a sensitivity table; it does not predict the real number.',
  },
  {
    id: 'batch.job_wall_time',
    origin: 'after',
    reason:
      'BATCH_JOB_DEADLINE_MS (375 s) and BATCH_ITEM_BUDGET_MS (15 s) are catalog ceilings used to decide promotion, not measurements of how long a traversal takes. Nothing here times a real batch.',
  },
  {
    id: 'after.spill_avoided',
    origin: 'after',
    reason:
      'The before run spent 5 shell calls parsing a search response the chat client had spilled to a file. The compacted response is ~13x smaller, but whether that clears the client\'s spill threshold is not knowable here — the threshold itself is unmeasurable (see client.inline_response_limit) — so those 5 calls are NOT counted as saved anywhere in this ledger.',
  },
  {
    id: 'after.agent_cpu',
    origin: 'after',
    reason:
      'Compaction moves work onto the agent: the seconds column charges the compactor\'s CPU on this box, which is not the CPU of the Windows box that would actually run it. The direction is real (the agent does strictly more work per call); the magnitude is not transferable.',
  },
  {
    id: 'after.recovery_calls',
    origin: 'after',
    reason:
      'Per-URL error slots are meant to remove the extra calls a dead page cost the Phase 1 traversal (the reported run spent 3 snapshots on ended listings reported active). Costing that saving needs a page that fails the way live ones do; every fixture here succeeds, so the saving is described and never counted.',
  },
];

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1]!;
}

function pctDelta(before: number | null, after: number | null): string {
  if (before === null || after === null) return '—';
  if (before === 0) return after === 0 ? '0.0%' : 'n/a (before 0)';
  const change = ((after - before) / before) * 100;
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function num(value: number | null, digits = 3): string {
  return value === null ? '—' : value.toFixed(digits);
}

interface BeforeCapture {
  capturedAt: string;
  node: string;
  source: { repoHead: string | null; dirtyPaths: string[] };
  ledger: { measured: LedgerRow[]; reported: LedgerRow[] };
  probes: Probe[];
  unmeasurable: { id: string; reason: string }[];
}

/**
 * Produce the before side by RUNNING the before harness, not by reading a
 * number off the committed capture. Two ledgers taken from the same tree,
 * the same Node and the same fixtures differ by the tool surface alone,
 * which is the only difference the diff below is entitled to claim. `--out`
 * points at a scratch file, so the committed baseline is never touched.
 */
function replayBeforeCapture(outPath: string, offline: boolean): { stdout: string } {
  const stdout = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'tools', 'measure', 'ledger.ts'), '--out', outPath, ...(offline ? ['--offline'] : [])],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return { stdout };
}

async function main(): Promise<void> {
  const outPath = arg('--out', join(REPO_ROOT, 'tools', 'measure', 'after-ledger.json'))!;
  const offline = process.argv.includes('--offline');
  const suppliedBefore = arg('--before');

  const scratch = await mkdtemp(join(tmpdir(), 'bb-measure-after-'));
  const parseHTML = await loadParseHtml();
  const ebay = await loadBuilt<EbayModule>('packages/site-ebay/dist/index.js');
  const kijiji = await loadBuilt<KijijiModule>('packages/site-kijiji/dist/index.js');
  const protocol = await loadBuilt<ProtocolModule>('packages/protocol/dist/index.js');
  const compact = await loadBuilt<CompactModule>('apps/windows-agent/dist/compact.js');
  const jobs = await loadBuilt<JobsModule>('apps/windows-agent/dist/jobs.js');
  const dashboards = await loadBuilt<DashboardModule>('apps/gateway/dist/dashboards/client.js');
  const telemetry = await loadBuilt<TelemetryModule>('packages/telemetry/dist/index.js');

  /* --- the before side ------------------------------------------------- */
  const beforePath = suppliedBefore ?? join(scratch, 'before-ledger.json');
  if (suppliedBefore === null) replayBeforeCapture(beforePath, offline);
  const before = JSON.parse(await readFile(beforePath, 'utf8')) as BeforeCapture;

  const baselinePath = join(REPO_ROOT, 'tools', 'measure', 'baseline-ledger.json');
  let baseline: BeforeCapture | null = null;
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as BeforeCapture;
  } catch {
    baseline = null;
  }

  /* --- the tool surface's own constants -------------------------------- */
  const constants: BatchConstants = {
    maxUrlsPerBatch: protocol.EXTRACT_MANY_MAX_URLS,
    maxInlineItems: protocol.MAX_INLINE_BATCH_ITEMS,
  };
  const searchDefaults = protocol.DEFAULT_SEARCH_COMPACTION;
  const batchPlan = planBatches(AFTER_ITEM_PAGES, constants, JOB_POLLS_FLOOR);

  const probes: Probe[] = [];
  const calls: SimulatedCall[] = [];
  const server = await startFixtureServer();

  try {
    /* --- environment ------------------------------------------------- */
    const reachability = offline
      ? ['www.ebay.ca', 'www.kijiji.ca'].map((host) => ({
          host,
          status: null,
          reachable: false,
          error: 'skipped (--offline)',
        }))
      : await Promise.all([probeReachability('www.ebay.ca'), probeReachability('www.kijiji.ca')]);

    /* --- preamble: dashboard.feed, now filtered and projected ---------- */
    const feedRoot = modelDealsFeed(
      REPORTED_FEED_RECORD_COUNT,
      Math.round(REPORTED_FEED_BYTES / REPORTED_FEED_RECORD_COUNT),
    );
    const feedFetch = ((): typeof fetch =>
      (() =>
        Promise.resolve(
          new Response(JSON.stringify(feedRoot), { status: 200, headers: { 'content-type': 'application/json' } }),
        )) as unknown as typeof fetch)();
    const feedClient = new dashboards.DashboardClient({
      baseUrl: 'https://dashboards.invalid',
      tokens: {},
      fetchImpl: feedFetch,
    });
    const feedFull = await timed(() => feedClient.feed('deals', 'full'));
    const feedIds = await timed(() => feedClient.feed('deals', 'ids'));
    const feedProjected = await timed(() =>
      feedClient.feed('deals', 'ids', { filter: { active: true }, fields: AFTER_FEED_FIELDS }),
    );
    const feedFullBytes = jsonBytes(feedFull.value.root);
    const feedIdsBytes = jsonBytes(feedIds.value.root);
    const feedProjectedBytes = jsonBytes(feedProjected.value.root);
    probes.push({
      id: 'dashboard.feed.after.projected',
      question: 'What does the preamble pull now, and how much of the saving is new?',
      basis: 'measured',
      bytes: feedProjectedBytes,
      ms: feedProjected.ms,
      detail: {
        call: `dashboard.feed{mode:"ids", filter:{active:true}, fields:${JSON.stringify(AFTER_FEED_FIELDS)}}`,
        fullBytes: feedFullBytes,
        idsOnlyBytes: feedIdsBytes,
        projectedBytes: feedProjectedBytes,
        listingsKept: feedProjected.value.listingCount,
        listingsHeld: feedProjected.value.totalListingCount,
        reductionVsFullPct: Number((100 - (feedProjectedBytes / feedFullBytes) * 100).toFixed(1)),
        attribution: {
          preExistingIdsModePct: Number((100 - (feedIdsBytes / feedFullBytes) * 100).toFixed(1)),
          phase2FilterAndFieldsPct: Number((100 - (feedProjectedBytes / feedIdsBytes) * 100).toFixed(1)),
          note:
            'mode "ids" is NOT a Phase 2 addition — it existed at the before capture and the before ledger already probed it. Only filter{active} and fields are new, and they are credited with the second figure only.',
        },
        caveat:
          'Record sizes inherit the modelled feed (38 records padded to the reported ~40 KB mean); the reductions are properties of DashboardClient.feed and hold for any input of this shape.',
      },
    });
    calls.push({
      phase: 'preamble',
      toolName: 'dashboard.feed',
      args: { dashboard: 'deals', mode: 'ids', filter: { active: true }, fields: [...AFTER_FEED_FIELDS] },
      response: feedProjected.value.root,
      durationMs: feedProjected.ms,
    });
    calls.push({
      phase: 'preamble',
      toolName: 'browser.session_open',
      args: { deviceId: 'dev_measure', profileName: 'ebay-research' },
      response: {
        browserSessionHandle: SESSION_HANDLE,
        deviceId: 'dev_measure',
        profileName: 'ebay-research',
        status: 'ready',
        tabs: [{ tabId: 't1', url: 'about:blank', title: '', active: true, pageRevision: 0 }],
      },
      durationMs: 0,
    });

    /* --- search page: the same constructed 240-row page, compacted ----- */
    const tracked = buildSearchResultsPage({ rows: MODELLED_ROWS_PER_PAGE });
    const trackedRun = await timed(() => {
      const { document } = parseHTML(tracked.html);
      return ebay.extractListingCandidates(document, tracked.pageUrl);
    });
    const rawSearchRecord = searchExtractRecord('ebay.ca.v1', tracked.pageUrl, trackedRun.value);
    const rawSearchBytes = jsonBytes({
      siteProfile: 'ebay.ca.v1',
      pageRevision: 1,
      record: rawSearchRecord,
      warnings: [],
    });
    const compactedSearch = await timed(() => compact.compactSearchPage(rawSearchRecord, searchDefaults));
    const openAndExtractResponse = {
      siteProfile: 'ebay.ca.v1',
      pageRevision: 1,
      record: compactedSearch.value.record,
      warnings: compactedSearch.value.warnings,
      finalUrl: tracked.pageUrl,
      navigationStatus: 'committed',
    };
    const compactedSearchBytes = jsonBytes(openAndExtractResponse);
    const searchRecord = compactedSearch.value.record;
    const returnedCandidates = Array.isArray(searchRecord.candidates)
      ? (searchRecord.candidates as Record<string, unknown>[])
      : [];
    probes.push({
      id: 'ebay.search.after.openAndExtract',
      question: 'What does one browser.open_and_extract return for the same 240-row page?',
      basis: 'modelled',
      bytes: compactedSearchBytes,
      ms: Number((trackedRun.ms + compactedSearch.ms).toFixed(3)),
      detail: {
        rows: tracked.rows,
        candidatesOnPage: trackedRun.value.length,
        uncompactedEnvelopeBytes: rawSearchBytes,
        compactedEnvelopeBytes: compactedSearchBytes,
        reductionPct: Number((100 - (compactedSearchBytes / rawSearchBytes) * 100).toFixed(1)),
        appliedDefaults: searchDefaults,
        matchedCount: searchRecord.matchedCount,
        returnedCount: searchRecord.returnedCount,
        hasMore: searchRecord.hasMore,
        nextOffset: searchRecord.nextOffset,
        pagingCallsForAllRows: searchPagingCalls(tracked.rows, searchDefaults.limit),
        bytesPerReturnedCandidate: Math.round(compactedSearchBytes / Math.max(1, returnedCandidates.length)),
        modelledParameters: {
          itmprpLength: MODELLED_ITMPRP_LENGTH,
          titleLength: MODELLED_TITLE_LENGTH,
          rowsPerPage: MODELLED_ROWS_PER_PAGE,
          meanHrefLength: tracked.meanHrefLength,
          meanTitleLength: tracked.meanTitleLength,
          trackingParams: ['_skw', 'itmmeta', 'hash', 'itmprp'],
        },
        caveat:
          'Real extractor and real compactor over the SAME page srpModel.ts builds for the before capture; ebay.ca answers this box 403, so the page is constructed. One call returns the default 40-row window of 240 — it is a smaller answer as well as a smaller payload, and paging to all 240 costs the calls reported above.',
      },
    });

    const allRowsOptions = protocol.SearchCompactionInput.parse({ limit: tracked.rows });
    const compactedAll = await timed(() => compact.compactSearchPage(rawSearchRecord, allRowsOptions));
    const compactedAllBytes = jsonBytes({
      siteProfile: 'ebay.ca.v1',
      pageRevision: 1,
      record: compactedAll.value.record,
      warnings: compactedAll.value.warnings,
      finalUrl: tracked.pageUrl,
      navigationStatus: 'committed',
    });
    probes.push({
      id: 'ebay.search.after.allRows',
      question: 'And if the routine insists on all 240 rows in one call?',
      basis: 'modelled',
      bytes: compactedAllBytes,
      ms: compactedAll.ms,
      detail: {
        limit: tracked.rows,
        reductionVsUncompactedPct: Number((100 - (compactedAllBytes / rawSearchBytes) * 100).toFixed(1)),
        note:
          'Canonical URLs and the field projection alone, with no window. This is the honest ceiling for "one call, whole page": the 40-row default is a smaller number because it is a smaller answer.',
      },
    });

    const fixtureHtml = await (await fetch(`${server.baseUrl}/ebay/search-results.html`)).text();
    const fixtureRun = await timed(() => {
      const { document } = parseHTML(fixtureHtml);
      return ebay.extractListingCandidates(document, 'https://www.ebay.ca/sch/i.html?_nkw=bulk+lego');
    });
    const fixtureRawRecord = searchExtractRecord(
      'ebay.ca.v1',
      'https://www.ebay.ca/sch/i.html?_nkw=bulk+lego',
      fixtureRun.value,
    );
    const fixtureCompacted = compact.compactSearchPage(fixtureRawRecord, searchDefaults);
    const fixtureUncompactedBytes = jsonBytes({
      siteProfile: 'ebay.ca.v1',
      pageRevision: 1,
      record: fixtureRawRecord,
      warnings: [],
    });
    const fixtureCompactedBytes = jsonBytes({
      siteProfile: 'ebay.ca.v1',
      pageRevision: 1,
      record: fixtureCompacted.record,
      warnings: fixtureCompacted.warnings,
      finalUrl: 'https://www.ebay.ca/sch/i.html?_nkw=bulk+lego',
      navigationStatus: 'committed',
    });
    probes.push({
      id: 'ebay.search.after.fixture',
      question: 'And over the checked-in fixture, where nothing is constructed?',
      basis: 'measured',
      bytes: fixtureCompactedBytes,
      ms: fixtureRun.ms,
      detail: {
        candidates: fixtureRun.value.length,
        uncompactedEnvelopeBytes: fixtureUncompactedBytes,
        compactedEnvelopeBytes: fixtureCompactedBytes,
        deltaBytes: fixtureCompactedBytes - fixtureUncompactedBytes,
        note:
          'Two candidates with bare /itm/<id>?hash=abc hrefs — almost no tracking payload to strip. Compaction makes this page BIGGER, not smaller: matchedCount/returnedCount/offset/hasMore/nextOffset/compacted plus finalUrl and navigationStatus are a fixed envelope cost that a two-row page cannot amortise. The win is a function of row count and href length, and this fixture has neither.',
      },
    });

    calls.push({
      phase: 'search_page',
      toolName: 'browser.open_and_extract',
      args: {
        browserSessionHandle: SESSION_HANDLE,
        tabId: 't1',
        url: tracked.pageUrl,
        siteProfile: 'ebay.ca.v1',
      },
      response: openAndExtractResponse,
      // Navigation plus extraction plus compaction are one call now, so the
      // call is charged all three. The compactor's CPU is real work the
      // Phase 1 surface did not do; hiding it would flatter the after side.
      durationMs: Number((trackedRun.ms + compactedSearch.ms).toFixed(3)),
    });

    /* --- item pages: one batch, promoted to a job ---------------------- */
    const itemUrl = `${server.baseUrl}/itm/123456789012`;
    const itemHtml = await (await fetch(itemUrl)).text();
    const itemRun = await timed(() => {
      const { document } = parseHTML(itemHtml);
      return ebay.extractListing(document, 'https://www.ebay.ca/itm/123456789012', { pageRevision: 2 });
    });
    const fullItemEnvelopeBytes = jsonBytes(
      itemExtractEnvelope('ebay.ca.v1', itemRun.value.record, itemRun.value.warnings),
    );
    const itemCompactRun = await timed(() =>
      compact.compactItemRecord('ebay.ca.v1', itemRun.value.record, itemRun.value.warnings),
    );
    probes.push({
      id: 'ebay.item.after.compact',
      question: 'What does one item cost as a compact batch slot instead of a full extract?',
      basis: 'measured',
      bytes: jsonBytes(itemCompactRun.value),
      ms: itemCompactRun.ms,
      detail: {
        servedFrom: itemUrl,
        fullExtractEnvelopeBytes: fullItemEnvelopeBytes,
        compactRecordBytes: jsonBytes(itemCompactRun.value),
        warnings: itemRun.value.warnings.length,
        note:
          'compactItemRecord() drops the per-field provenance/confidence envelope, which is what makes a record auditable and also most of its size. A batch keeps the flat scoring fields; the full record is still one browser.extract away.',
      },
    });

    // Canonical URLs come out of the compacted search response itself —
    // which is the point of canonicalizeUrls: the traversal feeds on what
    // the search call already returned, with no rewriting in the model.
    const batchUrls = returnedCandidates
      .slice(0, AFTER_ITEM_PAGES)
      .map((row, index) =>
        typeof row.url === 'string' ? row.url : `https://www.ebay.ca/itm/12345678901${index}`,
      );

    const store = new jobs.BatchJobStore({ retentionMs: 600_000 });
    const job = store.create(SESSION_HANDLE, batchUrls.length, true, []);
    // The accept response is what browser.extract_many returns for a
    // promoted batch: a jobId and nothing else. Snapshotted before the
    // slots land, because the store mutates the job in place.
    const acceptResponse = structuredClone(jobs.jobProgress(job)) as Record<string, unknown>;
    for (const [index, url] of batchUrls.entries()) {
      store.append(job.jobId, {
        url,
        finalUrl: url,
        ok: true,
        siteProfile: 'ebay.ca.v1',
        pageRevision: 2 + index,
        record: itemCompactRun.value,
        warnings: itemRun.value.warnings,
        error: null,
      });
    }
    store.finish(job.jobId, 'completed', []);
    const pollResponse = jobs.jobProgress(job, 0);
    const emptyPollResponse = jobs.jobProgress(job, batchUrls.length);

    probes.push({
      id: 'batch.extract_many.after.accept',
      question: 'What does the call that starts a promoted batch return?',
      basis: 'measured',
      bytes: jsonBytes(acceptResponse),
      ms: 0,
      detail: {
        urls: batchUrls.length,
        maxInlineBatchItems: constants.maxInlineItems,
        extractManyMaxUrls: constants.maxUrlsPerBatch,
        resolvedMode: acceptResponse.mode,
        status: acceptResponse.status,
        results: Array.isArray(acceptResponse.results) ? acceptResponse.results.length : null,
        note:
          'Zero result slots. This is why the poll below is a structural cost of the after surface and not an optional extra: a promoted batch hands back a jobId, and nothing else, in the call that starts it.',
      },
    });
    probes.push({
      id: 'batch.job_status.after.firstPoll',
      question: 'And what does the poll that collects it return?',
      basis: 'modelled',
      bytes: jsonBytes(pollResponse),
      ms: 0,
      detail: {
        slots: batchUrls.length,
        bytesPerSlot: Math.round(jsonBytes(pollResponse) / Math.max(1, batchUrls.length)),
        note:
          'Real BatchJobStore and real jobProgress(); the seventeen slots are seventeen copies of the one checked-in item fixture, exactly as the before ledger replays seventeen copies of the same extract. A real batch of seventeen different listings would differ per slot.',
      },
    });
    probes.push({
      id: 'batch.job_status.after.emptyPoll',
      question: 'What does one MORE poll cost, once the results are already read?',
      basis: 'measured',
      bytes: jsonBytes(emptyPollResponse),
      ms: 0,
      detail: {
        sinceIndex: batchUrls.length,
        note:
          'sinceIndex is what makes over-polling cheap rather than free: a poll that has nothing new still costs its progress envelope, and that is the marginal price of each extra poll in the sensitivity table.',
      },
    });

    calls.push({
      phase: 'item_pages',
      toolName: 'browser.extract_many',
      args: {
        browserSessionHandle: SESSION_HANDLE,
        tabId: 't1',
        urls: batchUrls,
        siteProfile: 'ebay.ca.v1',
        compact: true,
      },
      response: acceptResponse,
      // The promoted call returns before the traversal runs, so none of the
      // traversal's CPU is inside its response time. It is charged here
      // anyway, because this call is what causes it and charging it to
      // nothing would make the after row look free.
      durationMs: Number((batchUrls.length * (itemRun.ms + itemCompactRun.ms)).toFixed(3)),
    });
    for (let poll = 0; poll < batchPlan.pollCalls; poll += 1) {
      calls.push({
        phase: 'item_pages',
        toolName: 'browser.job_status',
        args: { browserSessionHandle: SESSION_HANDLE, jobId: job.jobId, sinceIndex: 0 },
        response: pollResponse,
        durationMs: 0,
      });
    }

    /* --- kijiji, the reachable half, through the same compactor -------- */
    const kijijiSearchHtml = await fixture('kijiji', 'search-results.html');
    const kijijiSearchRun = await timed(() => {
      const { document } = parseHTML(kijijiSearchHtml);
      return kijiji.extractSearchResults(
        document,
        'https://www.kijiji.ca/b-toys-games/gta-greater-toronto-area/lego/k0c108l1700272',
      );
    });
    const kijijiRaw = {
      siteProfile: 'kijiji.ca.v1',
      pageKind: 'search',
      pageUrl: 'https://www.kijiji.ca/b-toys-games/gta-greater-toronto-area/lego/k0c108l1700272',
      candidateCount: kijijiSearchRun.value.results.length,
      candidates: kijijiSearchRun.value.results,
      note: 'Candidate snippets are traversal hints; open each ad URL and extract it for canonical evidence.',
    };
    const kijijiCompacted = compact.compactSearchPage(kijijiRaw, searchDefaults);
    const kijijiRawBytes = jsonBytes(kijijiRaw);
    const kijijiCompactedBytes = jsonBytes(kijijiCompacted.record);
    probes.push({
      id: 'kijiji.search.after.compact',
      question: 'Does the same compaction hold on the marketplace this box can actually reach?',
      basis: 'measured',
      bytes: kijijiCompactedBytes,
      ms: kijijiSearchRun.ms,
      detail: {
        candidates: kijijiSearchRun.value.results.length,
        uncompactedBytes: kijijiRawBytes,
        compactedBytes: kijijiCompactedBytes,
        deltaBytes: kijijiCompactedBytes - kijijiRawBytes,
        note:
          'Two ad cards, so compaction adds bytes here too — the same fixed envelope the eBay fixture pays. www.kijiji.ca answers this box 200, but the fixture is still what is measured: a live capture would be a different run, not this one.',
      },
    });

    const kijijiVipHtml = await fixture('kijiji', 'vip-jsonld.html');
    const kijijiVipRun = await timed(() => {
      const { document } = parseHTML(kijijiVipHtml);
      return kijiji.extractKijijiListing(
        document,
        'https://www.kijiji.ca/v-toys-games/city-of-toronto/lego-bulk-lot/1700000000',
      );
    });
    const kijijiVipCompact = compact.compactItemRecord('kijiji.ca.v1', kijijiVipRun.value.record);
    probes.push({
      id: 'kijiji.vip.after.compact',
      question: 'And one Kijiji ad as a batch slot?',
      basis: 'measured',
      bytes: jsonBytes(kijijiVipCompact),
      ms: kijijiVipRun.ms,
      detail: {
        fullEnvelopeBytes: jsonBytes(
          itemExtractEnvelope('kijiji.ca.v1', kijijiVipRun.value.record, kijijiVipRun.value.warnings),
        ),
      },
    });

    /* --- the write --------------------------------------------------- */
    // Deliberately the SAME six records the before capture writes, with the
    // same hand-built response. Phase 2 did not make this call cheaper and
    // the row must not pretend it did; what Phase 2 added is measured as a
    // probe below, not folded into the diff.
    const upsertPayload = {
      dashboard: 'deals',
      listings: modelDealsFeed(6, 400).listings as Record<string, unknown>[],
    };
    calls.push({
      phase: 'upsert',
      toolName: 'dashboard.upsert',
      args: upsertPayload,
      response: { dashboard: 'deals', ok: true, result: { written: 6 } },
      durationMs: 0,
    });

    let capturedUpsertBody = '';
    const upsertFetch = ((): typeof fetch =>
      ((_url: string, init?: { body?: string }) => {
        capturedUpsertBody = init?.body ?? '';
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, upserted: 6, unchanged: AFTER_TOUCH_COUNT }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as unknown as typeof fetch)();
    const upsertClient = new dashboards.DashboardClient({
      baseUrl: 'https://dashboards.invalid',
      tokens: { deals: 'ingest-token-placeholder' },
      fetchImpl: upsertFetch,
    });
    const touchRecords = Array.from({ length: AFTER_TOUCH_COUNT }, (_unused, index) => ({
      id: `ebay-2${String(index + 6).padStart(11, '0')}`,
      lastSeen: '2026-08-29T12:00:00.000Z',
    }));
    await upsertClient.upsert('deals', upsertPayload.listings, touchRecords);
    const withTouchBytes = Buffer.byteLength(capturedUpsertBody, 'utf8');
    const asFullRecords = modelDealsFeed(6 + AFTER_TOUCH_COUNT, 400).listings as Record<string, unknown>[];
    await upsertClient.upsert('deals', asFullRecords, []);
    const asFullBytes = Buffer.byteLength(capturedUpsertBody, 'utf8');
    probes.push({
      id: 'dashboard.upsert.after.touch',
      question: 'What does refreshing the other eleven verified listings cost now?',
      basis: 'measured',
      bytes: withTouchBytes,
      ms: 0,
      detail: {
        fullRecords: 6,
        touched: AFTER_TOUCH_COUNT,
        bodyWithTouchBytes: withTouchBytes,
        bodyIfAllSentWholeBytes: asFullBytes,
        savedPct: Number((100 - (withTouchBytes / asFullBytes) * 100).toFixed(1)),
        note:
          'The real DashboardClient.upsert body, captured off a stub fetch. This is a capability the before surface did not have at all — it is NOT part of the upsert row in the diff, because the diff compares the same six-record write on both sides.',
      },
    });

    /* --- run the calls through the recorder and read the log back ------ */
    const logDir = await mkdtemp(join(tmpdir(), 'bb-measure-'));
    const recorder = telemetry.createCallRecorder({ enabled: true, dir: logDir, runId: 'run_after' });
    const phaseOf = new Map<number, string>();
    calls.forEach((call, index) => {
      phaseOf.set(index, call.phase);
      recorder.record({
        toolName: call.toolName,
        args: call.args,
        response: call.response,
        durationMs: call.durationMs,
        outcome: 'ok',
        errorCode: null,
        sessionId: SESSION_HANDLE,
        requestId: `req_${index}`,
      });
    });
    await recorder.close();
    const logText = await readFile(recorder.logPath!, 'utf8');
    const records = logText
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            requestId: string;
            argBytes: number;
            responseBytes: number;
            durationMs: number;
            tool: string;
          },
      );
    await rm(logDir, { recursive: true, force: true });

    const phaseNote: Record<string, string> = {
      preamble:
        'dashboard.feed{mode:"ids",filter,fields} + browser.session_open. Call count unchanged from Phase 1; only the payload moved.',
      search_page: `1 call (browser.open_and_extract collapses navigate+extract and compacts server-side at limit ${String(searchDefaults.limit)} of ${String(tracked.rows)} rows)`,
      item_pages: `1 browser.extract_many (${String(AFTER_ITEM_PAGES)} URLs > MAX_INLINE_BATCH_ITEMS ${String(constants.maxInlineItems)}, so mode "auto" promotes to a job) + ${String(batchPlan.pollCalls)} browser.job_status poll(s) — the FLOOR, not a prediction`,
      upsert: 'Unchanged: the same six-record write, at the same cost. touch[] is measured as a probe, not folded in here.',
    };

    const after: LedgerRow[] = PHASES.map((phase) => {
      const inPhase = records.filter((record) => phaseOf.get(Number(record.requestId.slice(4))) === phase);
      const bytes = inPhase.reduce((total, record) => total + record.argBytes + record.responseBytes, 0);
      const ms = inPhase.reduce((total, record) => total + record.durationMs, 0);
      return {
        phase,
        calls: inPhase.length,
        bytes,
        seconds: Number((ms / 1000).toFixed(3)),
        basis: 'derived',
        note: `${String(inPhase.length)} call(s): ${phaseNote[phase] ?? ''} Bytes measured; seconds are extractor+compactor CPU only.`,
      };
    });

    /* --- diff ---------------------------------------------------------- */
    const beforeByPhase = new Map(before.ledger.measured.map((row) => [row.phase, row]));
    const diff = after.map((row) => {
      const priorRow = beforeByPhase.get(row.phase) ?? null;
      return {
        phase: row.phase,
        basis: 'derived' as Basis,
        callsBefore: priorRow?.calls ?? null,
        callsAfter: row.calls,
        callsDeltaPct: pctDelta(priorRow?.calls ?? null, row.calls),
        bytesBefore: priorRow?.bytes ?? null,
        bytesAfter: row.bytes,
        bytesDeltaPct: pctDelta(priorRow?.bytes ?? null, row.bytes),
        secondsBefore: priorRow?.seconds ?? null,
        secondsAfter: row.seconds,
        secondsDeltaPct: pctDelta(priorRow?.seconds ?? null, row.seconds),
      };
    });
    const sum = (rows: LedgerRow[], key: 'calls' | 'bytes' | 'seconds'): number =>
      rows.reduce((total, row) => total + (row[key] ?? 0), 0);
    const totals = {
      callsBefore: sum(before.ledger.measured, 'calls'),
      callsAfter: sum(after, 'calls'),
      bytesBefore: sum(before.ledger.measured, 'bytes'),
      bytesAfter: sum(after, 'bytes'),
      secondsBefore: Number(sum(before.ledger.measured, 'seconds').toFixed(3)),
      secondsAfter: Number(sum(after, 'seconds').toFixed(3)),
    };

    /* --- did the replayed before agree with the committed baseline? ---- */
    const baselineDrift =
      baseline === null
        ? { compared: false, reason: `no readable capture at ${baselinePath}` }
        : {
            compared: true,
            baselineHead: baseline.source.repoHead,
            replayHead: before.source.repoHead,
            rows: baseline.ledger.measured.map((row) => {
              const replayed = before.ledger.measured.find((entry) => entry.phase === row.phase) ?? null;
              return {
                phase: row.phase,
                baselineCalls: row.calls,
                replayCalls: replayed?.calls ?? null,
                baselineBytes: row.bytes,
                replayBytes: replayed?.bytes ?? null,
                identical: replayed !== null && replayed.calls === row.calls && replayed.bytes === row.bytes,
              };
            }),
          };

    const itemPhaseRow = after.find((row) => row.phase === 'item_pages')!;
    const emptyPollBytes = jsonBytes(emptyPollResponse);
    const pollSensitivity = POLL_SENSITIVITY.map((polls) => {
      const plan = planBatches(AFTER_ITEM_PAGES, constants, polls);
      // sinceIndex means a slot is never sent twice, so every poll after the
      // one that collects the results costs its progress envelope and no
      // more. That makes this a floor on the extra bytes, not a forecast:
      // a run that polls a job mid-flight splits the same slots across more
      // responses, it does not duplicate them.
      return {
        pollsPerJob: polls,
        itemPhaseCalls: plan.calls,
        totalCalls: totals.callsAfter - (itemPhaseRow.calls ?? 0) + plan.calls,
        callsPerItem: plan.callsPerItem,
        itemPhaseBytes: (itemPhaseRow.bytes ?? 0) + (polls - 1) * emptyPollBytes,
        note: polls === JOB_POLLS_FLOOR ? 'the floor this ledger charges' : 'sensitivity only',
      };
    });

    const itemCountSensitivity = ITEM_COUNT_SENSITIVITY.map((items) => {
      const plan = planBatches(items, constants, JOB_POLLS_FLOOR);
      return {
        items,
        batches: plan.batchCalls,
        modes: plan.steps.map((step) => `${String(step.size)}:${step.mode}`).join(','),
        polls: plan.pollCalls,
        afterCalls: plan.calls,
        beforeCalls: phase1ItemPageCalls(items),
        afterCallsPerItem: plan.callsPerItem,
      };
    });

    /* --- where the after story is weaker than the headline ------------- */
    // Written out rather than left for the reader to notice. Each entry is
    // a real cost or a real limit of the after surface that the diff table
    // above either understates or does not show at all.
    const weaknesses = [
      {
        id: 'item_phase.assumes_one_poll',
        statement: `The ${String(itemPhaseRow.calls ?? 0)}-call item phase assumes ONE browser.job_status lands after the job has already finished. Every extra poll is +1 call and +${String(emptyPollBytes)} B.`,
        detail: 'A run that polls while the job is still traversing pays more calls for the same records; see the poll-sensitivity table.',
      },
      {
        id: 'promotion_threshold.is_conservative',
        statement: `MAX_INLINE_BATCH_ITEMS is ${String(constants.maxInlineItems)}, so anything above ${String(constants.maxInlineItems)} URLs is a job. The +1 poll is not an edge case — it is what every real traversal pays.`,
        detail: `The threshold is floor((${String(protocol.EXTRACT_MANY_TIMEOUT_MS)} - ${String(protocol.BATCH_INLINE_RESERVE_MS)}) / ${String(protocol.BATCH_ITEM_BUDGET_MS)}), charging each item a SNAPSHOT_TIMEOUT_MS ceiling rather than an expected cost. Raising the per-item estimate to something measured would raise the inline batch size and delete the poll; nothing here measures it.`,
      },
      {
        id: 'search.window_is_a_smaller_answer',
        statement: `The search call returns ${String(searchRecord.returnedCount)} of ${String(searchRecord.candidateCount)} rows, not 240 compacted rows. It is a smaller ANSWER as well as a smaller payload.`,
        detail: `All 240 rows in one call is ${String(compactedAllBytes)} B (still ${String(Number((100 - (compactedAllBytes / rawSearchBytes) * 100).toFixed(1)))}% under the uncompacted page); paging to 240 at the default window is ${String(searchPagingCalls(tracked.rows, searchDefaults.limit))} calls, which would make this phase MORE calls than the before surface's 2.`,
      },
      {
        id: 'compaction.costs_bytes_on_small_pages',
        statement: `On a small page compaction ADDS bytes: the eBay fixture goes ${String(fixtureUncompactedBytes)} → ${String(fixtureCompactedBytes)} B and the Kijiji fixture ${String(kijijiRawBytes)} → ${String(kijijiCompactedBytes)} B.`,
        detail: 'matchedCount/returnedCount/offset/hasMore/nextOffset/compacted, plus finalUrl and navigationStatus, are a fixed envelope only a long page amortises. The win is a function of row count and href length.',
      },
      {
        id: 'preamble.win_mostly_predates_phase2',
        statement: 'Most of the preamble reduction is dashboard.feed mode "ids", which existed before Phase 2 and which the before run simply did not use.',
        detail: `ids alone: ${String(Number((100 - (feedIdsBytes / feedFullBytes) * 100).toFixed(1)))}% off the full feed. filter{active} + fields add ${String(Number((100 - (feedProjectedBytes / feedIdsBytes) * 100).toFixed(1)))}% on top of that, and only the second figure is Phase 2's.`,
      },
      {
        id: 'reported_savings.not_counted',
        statement: 'The 5 shell calls and the 3 recovery snapshots the 2026-08-29 run spent are NOT counted as saved anywhere in this ledger.',
        detail: 'Both would need something this box does not have — the client\'s spill threshold, and a page that fails the way live ones do. See unmeasurable after.spill_avoided and after.recovery_calls.',
      },
      {
        id: 'agent_cpu.rises',
        statement: 'Compaction is agent-side work the Phase 1 surface did not do; the seconds column shows it on this box and cannot transfer it to the Windows one.',
        detail: 'Bytes were traded for CPU on the machine that owns the browser. The trade looks right, but only one side of it is measured here.',
      },
      {
        id: 'seconds.are_noise_at_this_scale',
        statement: 'The seconds column is extractor + compactor CPU measured in two different Node processes; differences under ~10 ms are noise, not findings.',
        detail: 'End-to-end wall time is unmeasurable here (no Chrome, no paired agent, no network). See unmeasurable call.wall_time.end_to_end.',
      },
    ];

    const unmeasurable: Unmeasurable[] = [
      ...before.unmeasurable.map((entry) => ({ ...entry, origin: 'carried' as const })),
      ...AFTER_UNMEASURABLE,
    ];

    const source = sourceState();
    const capture = {
      capturedAt: new Date().toISOString(),
      node: process.version,
      source,
      reachability,
      toolSurfaceConstants: {
        EXTRACT_MANY_MAX_URLS: protocol.EXTRACT_MANY_MAX_URLS,
        MAX_INLINE_BATCH_ITEMS: protocol.MAX_INLINE_BATCH_ITEMS,
        EXTRACT_MANY_TIMEOUT_MS: protocol.EXTRACT_MANY_TIMEOUT_MS,
        BATCH_INLINE_RESERVE_MS: protocol.BATCH_INLINE_RESERVE_MS,
        BATCH_ITEM_BUDGET_MS: protocol.BATCH_ITEM_BUDGET_MS,
        BATCH_JOB_DEADLINE_MS: protocol.BATCH_JOB_DEADLINE_MS,
        DEFAULT_SEARCH_COMPACTION: searchDefaults,
        readFrom: 'packages/protocol/dist/index.js',
        note: 'Every call count below is derived from these; none is chosen.',
      },
      batchPlan,
      ledger: { after, before: before.ledger.measured, reported: before.ledger.reported },
      diff: { phases: diff, totals },
      pollSensitivity,
      itemCountSensitivity,
      beforeCapture: {
        path: suppliedBefore ?? '(replayed into a scratch file by this run)',
        capturedAt: before.capturedAt,
        node: before.node,
        source: before.source,
      },
      baselineDrift,
      weaknesses,
      probes,
      unmeasurable,
    };
    await writeFile(outPath, `${JSON.stringify(capture, null, 2)}\n`, 'utf8');

    /* --- report -------------------------------------------------------- */
    console.log('Browser Bridge — deals-routine call-budget ledger (AFTER, with before → after diff)');
    console.log(`captured ${capture.capturedAt}  node ${capture.node}  head ${source.repoHead ?? 'unknown'}`);
    if (source.dirtyPaths.length > 0) {
      console.log(`NOT a clean HEAD capture — ${String(source.dirtyPaths.length)} tracked file(s) differ from HEAD:`);
      for (const path of source.dirtyPaths) console.log(`    ${path}`);
    }
    console.log(
      `before side: ${
        suppliedBefore === null ? 'replayed by tools/measure/ledger.ts in this run' : `read from ${suppliedBefore}`
      } at head ${before.source.repoHead ?? 'unknown'}`,
    );
    console.log('');

    console.log('Live reachability from this box');
    console.log(
      table(
        ['host', 'status', 'usable'],
        reachability.map((entry) => [
          String(entry.host),
          entry.status === null ? `— (${String(entry.error ?? 'no answer')})` : String(entry.status),
          entry.reachable === true ? 'yes' : 'no',
        ]),
      ),
    );
    console.log('');

    console.log('Tool-surface constants the call counts are derived from (read from the built protocol package)');
    console.log(
      table(
        ['constant', 'value'],
        [
          ['EXTRACT_MANY_MAX_URLS', String(protocol.EXTRACT_MANY_MAX_URLS)],
          ['MAX_INLINE_BATCH_ITEMS', String(protocol.MAX_INLINE_BATCH_ITEMS)],
          [
            '  = floor((EXTRACT_MANY_TIMEOUT_MS - BATCH_INLINE_RESERVE_MS) / BATCH_ITEM_BUDGET_MS)',
            `floor((${String(protocol.EXTRACT_MANY_TIMEOUT_MS)} - ${String(protocol.BATCH_INLINE_RESERVE_MS)}) / ${String(protocol.BATCH_ITEM_BUDGET_MS)})`,
          ],
          ['BATCH_JOB_DEADLINE_MS', String(protocol.BATCH_JOB_DEADLINE_MS)],
          ['DEFAULT_SEARCH_COMPACTION.limit', String(searchDefaults.limit)],
          ['DEFAULT_SEARCH_COMPACTION.canonicalizeUrls', String(searchDefaults.canonicalizeUrls)],
        ],
      ),
    );
    console.log('');

    console.log('BEFORE → AFTER (both replayed on this tree, this Node, these fixtures)');
    console.log(
      table(
        ['phase', 'calls', '→', 'Δ', 'bytes', '→', 'Δ', 'secs', '→', 'basis'],
        [
          ...diff.map((row) => [
            PHASE_LABEL[row.phase] ?? row.phase,
            String(row.callsBefore ?? '—'),
            String(row.callsAfter ?? '—'),
            row.callsDeltaPct,
            kib(row.bytesBefore),
            kib(row.bytesAfter),
            row.bytesDeltaPct,
            num(row.secondsBefore),
            num(row.secondsAfter),
            row.basis,
          ]),
          [
            'TOTAL',
            String(totals.callsBefore),
            String(totals.callsAfter),
            pctDelta(totals.callsBefore, totals.callsAfter),
            kib(totals.bytesBefore),
            kib(totals.bytesAfter),
            pctDelta(totals.bytesBefore, totals.bytesAfter),
            num(totals.secondsBefore),
            num(totals.secondsAfter),
            'derived',
          ],
        ],
      ),
    );
    console.log('  calls: derived from the tool surface. bytes: measured off the recorder, over');
    console.log('  fixture-real and constructed-page-modelled inputs. secs: extractor + compactor');
    console.log('  CPU on THIS box only — never end-to-end wall time (see unmeasurable, below).');
    console.log('');

    const itemsAfter = after.find((row) => row.phase === 'item_pages')?.calls ?? 0;
    const itemsBefore = beforeByPhase.get('item_pages')?.calls ?? 0;
    console.log('Headline');
    console.log(
      table(
        ['what', 'before', 'after', 'change', 'basis'],
        [
          [
            'total tool calls, one routine',
            String(totals.callsBefore),
            String(totals.callsAfter),
            pctDelta(totals.callsBefore, totals.callsAfter),
            'derived',
          ],
          [
            'search-page response bytes (240-row page)',
            kib(rawSearchBytes),
            kib(compactedSearchBytes),
            pctDelta(rawSearchBytes, compactedSearchBytes),
            'modelled',
          ],
          [
            'preamble bytes (feed + session_open)',
            kib(beforeByPhase.get('preamble')?.bytes ?? null),
            kib(after.find((row) => row.phase === 'preamble')?.bytes ?? null),
            pctDelta(
              beforeByPhase.get('preamble')?.bytes ?? null,
              after.find((row) => row.phase === 'preamble')?.bytes ?? null,
            ),
            'modelled input, measured reduction',
          ],
          [
            `calls per canonical item (${String(AFTER_ITEM_PAGES)} items)`,
            (itemsBefore / AFTER_ITEM_PAGES).toFixed(3),
            (itemsAfter / AFTER_ITEM_PAGES).toFixed(3),
            pctDelta(itemsBefore, itemsAfter),
            'derived (at the 1-poll floor)',
          ],
        ],
      ),
    );
    console.log('');

    console.log(`Where the item-page phase actually stands (MAX_INLINE_BATCH_ITEMS = ${String(constants.maxInlineItems)})`);
    console.log(
      table(
        ['polls per job', 'item-phase calls', 'total calls', 'calls/item', 'item-phase bytes', 'note'],
        pollSensitivity.map((row) => [
          String(row.pollsPerJob),
          String(row.itemPhaseCalls),
          String(row.totalCalls),
          row.callsPerItem.toFixed(3),
          kib(row.itemPhaseBytes),
          row.note,
        ]),
      ),
    );
    console.log('  A promoted batch returns a jobId and no results, so >= 1 poll is structural.');
    console.log('  How many polls a real run spends is unmeasurable here; the ledger charges 1.');
    console.log('');

    console.log('The promotion rule, applied (derived from the constants above, not chosen)');
    console.log(
      table(
        ['items', 'batches', 'sizes:mode', 'polls', 'after calls', 'before calls', 'after calls/item'],
        itemCountSensitivity.map((row) => [
          String(row.items),
          String(row.batches),
          row.modes,
          String(row.polls),
          String(row.afterCalls),
          String(row.beforeCalls),
          row.afterCallsPerItem.toFixed(3),
        ]),
      ),
    );
    console.log('');

    console.log('The 160 KB search extract, after');
    console.log(
      table(
        ['what', 'bytes', 'basis'],
        [
          [
            `240-row page, uncompacted (the before surface)`,
            kib(rawSearchBytes),
            'real extractor, constructed page',
          ],
          [
            `same page through browser.open_and_extract defaults (${String(searchRecord.returnedCount)} of ${String(searchRecord.candidateCount)} rows)`,
            kib(compactedSearchBytes),
            `real extractor + real compactor — ${String(
              Number((100 - (compactedSearchBytes / rawSearchBytes) * 100).toFixed(1)),
            )}% smaller`,
          ],
          [
            'same page, all 240 rows in one call (limit 240)',
            kib(compactedAllBytes),
            `real compactor — ${String(
              Number((100 - (compactedAllBytes / rawSearchBytes) * 100).toFixed(1)),
            )}% smaller`,
          ],
          [
            `paging to all 240 rows at the default window`,
            `${String(searchPagingCalls(tracked.rows, searchDefaults.limit))} calls`,
            'derived from DEFAULT_SEARCH_COMPACTION.limit',
          ],
          ['the live run', kib(160 * 1024), 'REPORTED by the operator, not measured here'],
        ],
      ),
    );
    console.log('');

    console.log('Probes');
    console.log(
      table(
        ['probe', 'basis', 'bytes', 'ms'],
        probes.map((probe) => [
          probe.id,
          probe.basis,
          kib(probe.bytes),
          probe.ms === null ? '—' : probe.ms.toFixed(2),
        ]),
      ),
    );
    console.log('');

    console.log('Ledger — as reported by the 2026-08-29 run (NOT measured here, NOT diffed against)');
    console.log(
      table(
        ['phase', 'calls', 'bytes', 'basis', 'note'],
        before.ledger.reported.map((row) => [
          PHASE_LABEL[row.phase] ?? row.phase,
          String(row.calls),
          kib(row.bytes),
          row.basis,
          row.note,
        ]),
      ),
    );
    console.log('');

    console.log('Replayed before vs the committed baseline-ledger.json');
    if (!baselineDrift.compared) {
      console.log(`  not compared: ${String(baselineDrift.reason)}`);
    } else {
      // `compared` and `rows` are independent fields rather than a
      // discriminated union, so narrowing on the former tells the compiler
      // nothing about the latter. An empty table is the honest rendering of
      // "compared, nothing to show" and beats asserting the field is there.
      const driftRows = baselineDrift.rows ?? [];
      console.log(
        table(
          ['phase', 'baseline calls', 'replay calls', 'baseline bytes', 'replay bytes', 'identical'],
          driftRows.map((row) => [
            PHASE_LABEL[row.phase] ?? row.phase,
            String(row.baselineCalls),
            String(row.replayCalls),
            kib(row.baselineBytes),
            kib(row.replayBytes),
            row.identical ? 'yes' : 'NO — see the JSON',
          ]),
        ),
      );
      console.log(
        `  baseline head ${String(baselineDrift.baselineHead)} vs replay head ${String(baselineDrift.replayHead)}`,
      );
    }
    console.log('');

    console.log('Where the after story is weaker than it looks');
    for (const entry of weaknesses) {
      console.log(`  ${entry.id}\n    ${entry.statement}\n      ${entry.detail}`);
    }
    console.log('');

    console.log('Not measurable from this box');
    for (const entry of unmeasurable) {
      console.log(`  ${entry.id}  [${entry.origin ?? 'after'}]\n    ${entry.reason}`);
    }
    console.log('');
    console.log(`After ledger written to ${outPath}`);
    console.log('The committed baseline-ledger.json was not written to by this run.');
  } finally {
    await server.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
