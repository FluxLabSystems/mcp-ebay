#!/usr/bin/env node
/**
 * Deals-routine call-budget ledger — the "before" capture.
 *
 * Run:  node tools/measure/ledger.ts [--out <path>] [--offline]
 *
 * Replays the shape of one deals run against the checked-in fixtures and
 * reports what each phase costs in calls, bytes and seconds. Every row says
 * how its number was arrived at, and rows that cannot be measured from this
 * box carry null and a reason instead of a plausible-looking figure: live
 * ebay.ca answers 403 here, there is no paired Windows agent and no Chrome,
 * and the chat client's inline-response limit is not observable from inside
 * the gateway at all.
 *
 * The per-call numbers come back out of @browser-bridge/telemetry rather
 * than being tallied inline — the harness records each simulated call the
 * way the broker would and then reads its own NDJSON back, so the ledger
 * exercises the instrumentation it is meant to justify.
 */
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
  searchExtractEnvelope,
  sourceState,
  table,
  timed,
  type Basis,
  type Probe,
} from './probes.ts';

interface EbayModule {
  extractListingCandidates: (document: Document, pageUrl: string) => unknown[];
  extractListing: (
    document: Document,
    pageUrl: string,
    context?: Record<string, unknown>,
  ) => { record: Record<string, unknown>; warnings: string[] };
}
interface KijijiModule {
  extractSearchResults: (document: Document, pageUrl: string) => { results: unknown[] };
  extractKijijiListing: (
    document: Document,
    pageUrl: string,
    context?: Record<string, unknown>,
  ) => { record: Record<string, unknown>; warnings: string[] };
}
interface DashboardModule {
  DashboardClient: new (options: {
    baseUrl: string;
    tokens: Record<string, string>;
    fetchImpl: typeof fetch;
  }) => { feed: (dashboard: string, mode: 'full' | 'ids') => Promise<{ root: Record<string, unknown> }> };
}
interface TelemetryModule {
  createCallRecorder: (options: Record<string, unknown>) => {
    logPath: string | null;
    record: (observation: Record<string, unknown>) => void;
    close: () => Promise<void>;
  };
}

/** One call as the broker would see it, tagged with the phase it belongs to. */
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

const PHASES = ['preamble', 'search_page', 'item_pages', 'upsert'] as const;
const PHASE_LABEL: Record<string, string> = {
  preamble: 'Preamble (feed + session_open)',
  search_page: 'One eBay search page',
  item_pages: '17 canonical item pages',
  upsert: 'dashboard.upsert',
};

/** The 2026-08-29 run as the operator reported it. Never mixed into measured rows. */
const REPORTED_LEDGER: LedgerRow[] = [
  {
    phase: 'preamble',
    calls: 5,
    bytes: REPORTED_FEED_BYTES,
    seconds: null,
    basis: 'reported',
    note: 'memory, tool load, dashboard.feed full (38 records, ~40 KB), session_open',
  },
  {
    phase: 'search_page',
    calls: 8,
    bytes: 160 * 1024,
    seconds: null,
    basis: 'reported',
    note: 'navigate + extract (160 KB, spilled to disk) + 5 shell calls to parse it + 1 snapshot for dropped titles',
  },
  {
    phase: 'item_pages',
    calls: 37,
    bytes: null,
    seconds: null,
    basis: 'reported',
    note: '2 calls each (navigate + extract) plus 3 snapshots for ended listings reported active',
  },
  { phase: 'upsert', calls: 0, bytes: null, seconds: null, basis: 'reported', note: 'budget exhausted before any write' },
];

const UNMEASURABLE = [
  {
    id: 'live.ebay.search.bytes',
    reason: 'www.ebay.ca answers this box with HTTP 403 (bot wall); no live 240-row SRP can be fetched or extracted here.',
  },
  {
    id: 'client.inline_response_limit',
    reason:
      'The threshold above which the chat client spills a tool response to a file lives in the client, not in the gateway or the agent. Nothing in this repo observes it.',
  },
  {
    id: 'call.wall_time.end_to_end',
    reason:
      'Real per-call latency is Chrome navigation plus the gateway-to-agent WebSocket round trip on a paired Windows box. No agent and no Chrome here; the seconds reported below are extractor CPU only.',
  },
  {
    id: 'shell.parse_calls',
    reason:
      'The 5 shell calls that parsed the spilled search response were client-side tool calls against a local file. They are not gateway calls and leave no trace this repo can read.',
  },
  {
    id: 'browser.snapshot.bytes',
    reason: 'browser.snapshot serializes a live accessibility tree; it has no fixture and no offline path.',
  },
  {
    id: 'dashboard.feed.live_bytes',
    reason:
      'The deals dashboard API is not reachable from this box and the harness holds no ingest token. The feed below is modelled at the reported size; only the mode-to-mode reduction is measured.',
  },
];

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1]!;
}

async function main(): Promise<void> {
  const outPath = arg('--out', join(REPO_ROOT, 'tools', 'measure', 'baseline-ledger.json'))!;
  const offline = process.argv.includes('--offline');

  const parseHTML = await loadParseHtml();
  const ebay = await loadBuilt<EbayModule>('packages/site-ebay/dist/index.js');
  const kijiji = await loadBuilt<KijijiModule>('packages/site-kijiji/dist/index.js');
  const dashboards = await loadBuilt<DashboardModule>('apps/gateway/dist/dashboards/client.js');
  const telemetry = await loadBuilt<TelemetryModule>('packages/telemetry/dist/index.js');

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

    /* --- preamble: dashboard.feed full vs ids -------------------------- */
    const feedRoot = modelDealsFeed(
      REPORTED_FEED_RECORD_COUNT,
      Math.round(REPORTED_FEED_BYTES / REPORTED_FEED_RECORD_COUNT),
    );
    const stubFetch = ((): typeof fetch =>
      (() =>
        Promise.resolve(
          new Response(JSON.stringify(feedRoot), { status: 200, headers: { 'content-type': 'application/json' } }),
        )) as unknown as typeof fetch)();
    const client = new dashboards.DashboardClient({
      baseUrl: 'https://dashboards.invalid',
      tokens: {},
      fetchImpl: stubFetch,
    });
    const feedFull = await timed(() => client.feed('deals', 'full'));
    const feedIds = await timed(() => client.feed('deals', 'ids'));
    const feedFullBytes = jsonBytes(feedFull.value.root);
    const feedIdsBytes = jsonBytes(feedIds.value.root);
    probes.push({
      id: 'dashboard.feed.full',
      question: 'What does the routine pull in just to know what it already has?',
      basis: 'modelled',
      bytes: feedFullBytes,
      ms: feedFull.ms,
      detail: {
        records: REPORTED_FEED_RECORD_COUNT,
        modelledFrom: `reported ~${REPORTED_FEED_BYTES} B total, padded to that mean per record`,
      },
    });
    probes.push({
      id: 'dashboard.feed.ids',
      question: 'How much of that does mode "ids" already avoid?',
      basis: 'measured',
      bytes: feedIdsBytes,
      ms: feedIds.ms,
      detail: {
        reductionPct: Number((100 - (feedIdsBytes / feedFullBytes) * 100).toFixed(1)),
        note: 'Reduction is a property of DashboardClient.feed and holds for any input of this shape; the absolute sizes inherit the modelled record size.',
        activeFilter: false,
      },
    });
    calls.push({
      phase: 'preamble',
      toolName: 'dashboard.feed',
      args: { dashboard: 'deals', mode: 'full' },
      response: feedFull.value.root,
      durationMs: feedFull.ms,
    });
    calls.push({
      phase: 'preamble',
      toolName: 'browser.session_open',
      args: { deviceId: 'dev_measure', profileName: 'ebay-research' },
      response: {
        browserSessionHandle: 'bs_0000000000000000',
        deviceId: 'dev_measure',
        profileName: 'ebay-research',
        status: 'ready',
        tabs: [{ tabId: 't1', url: 'about:blank', title: '', active: true, pageRevision: 0 }],
      },
      durationMs: 0,
    });

    /* --- search page: the checked-in fixture --------------------------- */
    const fixtureUrl = `${server.baseUrl}/ebay/search-results.html`;
    const fixtureHtml = await (await fetch(fixtureUrl)).text();
    const fixtureRun = await timed(() => {
      const { document } = parseHTML(fixtureHtml);
      return ebay.extractListingCandidates(document, 'https://www.ebay.ca/sch/i.html?_nkw=bulk+lego');
    });
    const fixtureEnvelope = searchExtractEnvelope(
      'ebay.ca.v1',
      'https://www.ebay.ca/sch/i.html?_nkw=bulk+lego',
      fixtureRun.value,
    );
    const fixtureBytes = jsonBytes(fixtureEnvelope);
    probes.push({
      id: 'ebay.search.fixture',
      question: 'What does browser.extract return for the checked-in search fixture?',
      basis: 'measured',
      bytes: fixtureBytes,
      ms: fixtureRun.ms,
      detail: {
        servedFrom: fixtureUrl,
        htmlBytes: Buffer.byteLength(fixtureHtml, 'utf8'),
        candidates: fixtureRun.value.length,
        bytesPerCandidate: Math.round(fixtureBytes / Math.max(1, fixtureRun.value.length)),
        naiveExtrapolationTo240: Math.round((fixtureBytes / Math.max(1, fixtureRun.value.length)) * 240),
        caveat:
          'The fixture carries 2 unique candidates with bare /itm/<id>?hash=abc hrefs. Scaling it to 240 rows under-predicts, because the live cost is dominated by href length, which the fixture does not have.',
      },
    });

    /* --- search page: a 240-row page modelled on the live shape --------- */
    const tracked = buildSearchResultsPage({ rows: MODELLED_ROWS_PER_PAGE });
    const trackedRun = await timed(() => {
      const { document } = parseHTML(tracked.html);
      return ebay.extractListingCandidates(document, tracked.pageUrl);
    });
    const trackedEnvelope = searchExtractEnvelope('ebay.ca.v1', tracked.pageUrl, trackedRun.value);
    const trackedBytes = jsonBytes(trackedEnvelope);

    const canonical = buildSearchResultsPage({ rows: MODELLED_ROWS_PER_PAGE, canonicalHrefs: true });
    const canonicalRun = await timed(() => {
      const { document } = parseHTML(canonical.html);
      return ebay.extractListingCandidates(document, canonical.pageUrl);
    });
    const canonicalBytes = jsonBytes(searchExtractEnvelope('ebay.ca.v1', canonical.pageUrl, canonicalRun.value));

    probes.push({
      id: 'ebay.search.modelled240',
      question: 'What would a 240-row search page cost through the current extract tool?',
      basis: 'modelled',
      bytes: trackedBytes,
      ms: trackedRun.ms,
      detail: {
        rows: tracked.rows,
        candidates: trackedRun.value.length,
        meanHrefLength: tracked.meanHrefLength,
        meanTitleLength: tracked.meanTitleLength,
        modelledParameters: {
          itmprpLength: MODELLED_ITMPRP_LENGTH,
          titleLength: MODELLED_TITLE_LENGTH,
          trackingParams: ['_skw', 'itmmeta', 'hash', 'itmprp'],
        },
        bytesPerCandidate: Math.round(trackedBytes / Math.max(1, trackedRun.value.length)),
        vsReported160KiB: Number((trackedBytes / (160 * 1024)).toFixed(2)),
        caveat:
          'Real code, constructed input. The extractor and the response envelope are the shipped ones; the page is generated here because ebay.ca is unreachable. Rescale with meanHrefLength if a captured page says otherwise.',
      },
    });
    probes.push({
      id: 'ebay.search.modelled240.canonicalHrefs',
      question: 'How much of that is the tracking query string?',
      basis: 'modelled',
      bytes: canonicalBytes,
      ms: canonicalRun.ms,
      detail: {
        meanHrefLength: canonical.meanHrefLength,
        savedBytes: trackedBytes - canonicalBytes,
        savedPct: Number((100 - (canonicalBytes / trackedBytes) * 100).toFixed(1)),
        note: 'Same page, same extractor, hrefs reduced to https://www.ebay.ca/itm/<id> — which is the only part of the URL the traversal then navigates to.',
      },
    });

    calls.push({
      phase: 'search_page',
      toolName: 'browser.navigate',
      args: { browserSessionHandle: 'bs_0000000000000000', tabId: 't1', url: tracked.pageUrl },
      response: {
        finalUrl: tracked.pageUrl,
        title: 'bulk lego | eBay Search',
        origin: 'https://www.ebay.ca',
        pageRevision: 1,
        navigationStatus: 'committed',
      },
      durationMs: 0,
    });
    calls.push({
      phase: 'search_page',
      toolName: 'browser.extract',
      args: { browserSessionHandle: 'bs_0000000000000000', tabId: 't1', siteProfile: 'ebay.ca.v1' },
      response: trackedEnvelope,
      durationMs: trackedRun.ms,
    });

    /* --- canonical item pages ------------------------------------------ */
    const itemUrl = `${server.baseUrl}/itm/123456789012`;
    const itemHtml = await (await fetch(itemUrl)).text();
    const itemRun = await timed(() => {
      const { document } = parseHTML(itemHtml);
      return ebay.extractListing(document, 'https://www.ebay.ca/itm/123456789012', { pageRevision: 2 });
    });
    const itemEnvelope = itemExtractEnvelope('ebay.ca.v1', itemRun.value.record, itemRun.value.warnings);
    const itemBytes = jsonBytes(itemEnvelope);
    probes.push({
      id: 'ebay.item.active',
      question: 'What does one canonical item extract return?',
      basis: 'measured',
      bytes: itemBytes,
      ms: itemRun.ms,
      detail: { servedFrom: itemUrl, warnings: itemRun.value.warnings.length },
    });

    const endedHtml = await fixture('ebay', 'ended-listing.html');
    const endedRun = await timed(() => {
      const { document } = parseHTML(endedHtml);
      return ebay.extractListing(document, 'https://www.ebay.ca/itm/222333444555', { pageRevision: 2 });
    });
    probes.push({
      id: 'ebay.item.ended',
      question: 'Does the extractor call an ended listing ended?',
      basis: 'measured',
      bytes: jsonBytes(itemExtractEnvelope('ebay.ca.v1', endedRun.value.record, endedRun.value.warnings)),
      ms: endedRun.ms,
      detail: {
        listingStatus: endedRun.value.record.listingStatus,
        note:
          'The fixture renders the banner element the selector list names. The live failure mode is the fallback below it: with no matching banner, detectListingStatus scans the first 2000 characters of body text and otherwise returns "active" whenever a title and a price are present.',
      },
    });

    const ITEM_PAGES = 17;
    for (let index = 0; index < ITEM_PAGES; index += 1) {
      calls.push({
        phase: 'item_pages',
        toolName: 'browser.navigate',
        args: { browserSessionHandle: 'bs_0000000000000000', tabId: 't1', url: `https://www.ebay.ca/itm/12345678901${index}` },
        response: {
          finalUrl: `https://www.ebay.ca/itm/12345678901${index}`,
          title: 'LEGO Bulk Lot',
          origin: 'https://www.ebay.ca',
          pageRevision: 2 + index,
          navigationStatus: 'committed',
        },
        durationMs: 0,
      });
      calls.push({
        phase: 'item_pages',
        toolName: 'browser.extract',
        args: { browserSessionHandle: 'bs_0000000000000000', tabId: 't1', siteProfile: 'ebay.ca.v1' },
        response: itemEnvelope,
        durationMs: itemRun.ms,
      });
    }

    /* --- kijiji, for contrast: it is the reachable half of the routine -- */
    const kijijiSearchHtml = await fixture('kijiji', 'search-results.html');
    const kijijiSearchRun = await timed(() => {
      const { document } = parseHTML(kijijiSearchHtml);
      return kijiji.extractSearchResults(document, 'https://www.kijiji.ca/b-toys-games/gta-greater-toronto-area/lego/k0c108l1700272');
    });
    probes.push({
      id: 'kijiji.search.fixture',
      question: 'What does the Kijiji search extract return for its fixture?',
      basis: 'measured',
      bytes: jsonBytes(kijijiSearchRun.value),
      ms: kijijiSearchRun.ms,
      detail: { candidates: kijijiSearchRun.value.results.length },
    });

    const kijijiVipHtml = await fixture('kijiji', 'vip-jsonld.html');
    const kijijiVipRun = await timed(() => {
      const { document } = parseHTML(kijijiVipHtml);
      return kijiji.extractKijijiListing(document, 'https://www.kijiji.ca/v-toys-games/city-of-toronto/lego-bulk-lot/1700000000');
    });
    probes.push({
      id: 'kijiji.vip.fixture',
      question: 'What does one Kijiji ad extract return?',
      basis: 'measured',
      bytes: jsonBytes(itemExtractEnvelope('kijiji.ca.v1', kijijiVipRun.value.record, kijijiVipRun.value.warnings)),
      ms: kijijiVipRun.ms,
      detail: { warnings: kijijiVipRun.value.warnings.length },
    });

    /* --- the write the run never reached -------------------------------- */
    const upsertPayload = {
      dashboard: 'deals',
      listings: (modelDealsFeed(6, 400).listings as Record<string, unknown>[]),
    };
    calls.push({
      phase: 'upsert',
      toolName: 'dashboard.upsert',
      args: upsertPayload,
      response: { dashboard: 'deals', ok: true, result: { written: 6 } },
      durationMs: 0,
    });

    /* --- run the calls through the recorder and read the log back -------- */
    const logDir = await mkdtemp(join(tmpdir(), 'bb-measure-'));
    const recorder = telemetry.createCallRecorder({ enabled: true, dir: logDir, runId: 'run_baseline' });
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
        sessionId: 'bs_0000000000000000',
        requestId: `req_${index}`,
      });
    });
    await recorder.close();
    const logText = await readFile(recorder.logPath!, 'utf8');
    const records = logText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { requestId: string; argBytes: number; responseBytes: number; durationMs: number; tool: string });
    await rm(logDir, { recursive: true, force: true });

    // requestId is req_<index> by construction above, which is how a log line
    // gets back to the phase that produced it: the recorder deliberately keeps
    // no phase field, because the broker has no such concept to give it.
    const measured: LedgerRow[] = PHASES.map((phase) => {
      const inPhase = records.filter((record) => phaseOf.get(Number(record.requestId.slice(4))) === phase);
      const bytes = inPhase.reduce((total, record) => total + record.argBytes + record.responseBytes, 0);
      const ms = inPhase.reduce((total, record) => total + record.durationMs, 0);
      return {
        phase,
        calls: inPhase.length,
        bytes,
        seconds: Number((ms / 1000).toFixed(3)),
        basis: 'derived',
        note: `${inPhase.length} call(s) at the current one-page-per-call tool surface; bytes measured, seconds are extractor CPU only`,
      };
    });

    /* --- report ---------------------------------------------------------- */
    const source = sourceState();
    const capture = {
      capturedAt: new Date().toISOString(),
      node: process.version,
      source,
      reachability,
      ledger: { measured, reported: REPORTED_LEDGER },
      probes,
      unmeasurable: UNMEASURABLE,
    };
    await writeFile(outPath, `${JSON.stringify(capture, null, 2)}\n`, 'utf8');

    console.log('Browser Bridge — deals-routine call-budget ledger (BEFORE)');
    console.log(`captured ${capture.capturedAt}  node ${capture.node}  head ${source.repoHead ?? 'unknown'}`);
    if (source.dirtyPaths.length > 0) {
      console.log(`NOT a clean HEAD capture — ${String(source.dirtyPaths.length)} tracked file(s) differ from HEAD:`);
      for (const path of source.dirtyPaths) console.log(`    ${path}`);
    }
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
    console.log('Ledger — replayed here against fixtures');
    console.log(
      table(
        ['phase', 'calls', 'bytes', 'seconds', 'basis'],
        measured.map((row) => [
          PHASE_LABEL[row.phase] ?? row.phase,
          String(row.calls),
          kib(row.bytes),
          row.seconds === null ? '—' : row.seconds.toFixed(3),
          row.basis,
        ]),
      ),
    );
    console.log('');
    console.log('Ledger — as reported by the 2026-08-29 run (NOT measured here)');
    console.log(
      table(
        ['phase', 'calls', 'bytes', 'basis', 'note'],
        REPORTED_LEDGER.map((row) => [
          PHASE_LABEL[row.phase] ?? row.phase,
          String(row.calls),
          kib(row.bytes),
          row.basis,
          row.note,
        ]),
      ),
    );
    console.log('');
    console.log('Probes');
    console.log(
      table(
        ['probe', 'basis', 'bytes', 'ms'],
        probes.map((probe) => [probe.id, probe.basis, kib(probe.bytes), probe.ms === null ? '—' : probe.ms.toFixed(2)]),
      ),
    );
    console.log('');
    console.log('The 160 KB search extract, stated plainly');
    const fixtureProbe = probes.find((probe) => probe.id === 'ebay.search.fixture')!;
    const modelledProbe = probes.find((probe) => probe.id === 'ebay.search.modelled240')!;
    const canonicalProbe = probes.find((probe) => probe.id === 'ebay.search.modelled240.canonicalHrefs')!;
    console.log(
      table(
        ['what', 'bytes', 'basis'],
        [
          [
            `checked-in fixture, ${String(fixtureProbe.detail.candidates)} candidates`,
            kib(fixtureProbe.bytes),
            'measured on this box',
          ],
          [
            'that fixture scaled linearly to 240 rows',
            kib(Number(fixtureProbe.detail.naiveExtrapolationTo240)),
            'arithmetic, and wrong — the fixture has no tracking params',
          ],
          [
            `240-row page modelled on the live href shape (mean href ${String(modelledProbe.detail.meanHrefLength)} chars)`,
            kib(modelledProbe.bytes),
            'real extractor, constructed page',
          ],
          [
            'same page with hrefs cut to https://www.ebay.ca/itm/<id>',
            kib(canonicalProbe.bytes),
            `real extractor, constructed page — ${String(canonicalProbe.detail.savedPct)}% smaller`,
          ],
          ['the live run', kib(160 * 1024), 'REPORTED by the operator, not measured here'],
        ],
      ),
    );
    console.log(
      `  The modelled page lands at ${String(modelledProbe.detail.vsReported160KiB)}x the reported 160 KB. That is close enough to`,
    );
    console.log('  say the reported figure is consistent with 240 tracked hrefs, and not close enough to');
    console.log('  substitute for capturing a real page once ebay.ca is reachable.');
    console.log('');
    console.log('Not measurable from this box');
    for (const entry of UNMEASURABLE) console.log(`  ${entry.id}\n    ${entry.reason}`);
    console.log('');
    console.log(`Ledger written to ${outPath}`);
  } finally {
    await server.close();
  }
}

// `--after` belongs to the sibling entry point, which costs the same
// routine against the Phase 2 tool surface and diffs the two. Dispatching
// here rather than duplicating the flag parsing means both spellings —
// `node tools/measure/after.ts` and `node tools/measure/ledger.ts --after` —
// run the same code. The default path below is untouched.
if (process.argv.includes('--after')) {
  await import('./after.ts');
} else {
  await main();
}
