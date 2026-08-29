/**
 * Command executors — SDD v0.5 §12, §15, §18. Every command re-validates
 * arguments against the normative schemas, checks expiry immediately
 * before execution, and runs serially per browser session.
 */
import { parseHTML } from 'linkedom';
import {
  click,
  enumerateImages,
  fetchImage,
  handoff,
  navigate,
  pressKey,
  screenshot,
  scroll,
  select,
  fill,
  snapshot,
  waitFor,
  type GalleryHints,
} from '@browser-bridge/browser-core';
import {
  BATCH_ITEM_BUDGET_MS,
  BATCH_JOB_DEADLINE_MS,
  BridgeError,
  ClickInput,
  DEFAULT_SEARCH_COMPACTION,
  ExtractInput,
  ExtractManyInput,
  FillInput,
  HandoffInput,
  IDEMPOTENCY_WINDOW_SECONDS,
  ImageGetInput,
  ImagesInput,
  JobStatusInput,
  KeyInput,
  MAX_INLINE_BATCH_ITEMS,
  NavigateInput,
  newArtifactId,
  OpenAndExtractInput,
  ScreenshotInput,
  ScrollInput,
  SelectInput,
  SessionOpenInput,
  SnapshotInput,
  TabsInput,
  WaitInput,
  type BatchExtractItem,
  type CommandEnvelope,
  type SearchCompaction,
} from '@browser-bridge/protocol';
import {
  classifyEbayPage,
  EBAY_GALLERY_SELECTORS,
  extractListing,
  extractListingCandidates,
  isListingPage,
  normalizeEbayImageUrl,
  EBAY_SITE_PROFILE_ID,
} from '@browser-bridge/site-ebay';
import {
  classifyKijijiPage,
  extractKijijiListing,
  extractSearchResults,
  KIJIJI_SITE_PROFILE_ID,
} from '@browser-bridge/site-kijiji';
import type { BrowserSessionRuntime } from '@browser-bridge/browser-core';
import { compactItemRecord, compactSearchPage } from './compact.js';
import { ensureDestination } from './destinationFlow.js';
import { BatchJobStore, jobProgress, type BatchJob } from './jobs.js';
import type { Logger } from './logger.js';
import type { SessionOpenResult } from './sessionManager.js';

export interface AgentArtifact {
  artifactId: string;
  mimeType: string;
  buffer: Buffer;
}

export interface ExecutionOutcome {
  result: Record<string, unknown>;
  pageRevision: number | null;
  artifacts: AgentArtifact[];
}

/**
 * Structural facade over SessionManager so transport-layer tests can stub
 * session ownership without a real browser.
 */
export interface SessionHost {
  open(profileName: string): Promise<SessionOpenResult>;
  resolve(browserSessionHandle: string): BrowserSessionRuntime;
  listActive(): BrowserSessionRuntime[];
  readonly isDegraded: boolean;
}

export interface ExecutorHost {
  sessions: SessionHost;
  logger: Logger;
  expectedPostalCode: string;
  /** Gallery hints; eBay hints by default, injectable for tests. */
  galleryHints?: GalleryHints;
  /** Batch job store; a process-wide one is used when the host supplies none. */
  jobs?: BatchJobStore;
}

/**
 * One store per agent process, because one agent process owns one browser.
 * Jobs are retained for the same window the gateway deduplicates command
 * submissions over (§18) — long enough that every legitimate poll lands,
 * short enough that a device does not accumulate finished traversals.
 */
let processJobStore: BatchJobStore | null = null;
function resolveJobStore(host: ExecutorHost): BatchJobStore {
  if (host.jobs !== undefined) return host.jobs;
  processJobStore ??= new BatchJobStore({ retentionMs: IDEMPOTENCY_WINDOW_SECONDS * 1000 });
  return processJobStore;
}

function remainingBudgetMs(envelope: CommandEnvelope, floorMs = 1000): number {
  const expires = Date.parse(envelope.expiresAt);
  const remaining = expires - Date.now() - 250;
  return Math.max(floorMs, remaining);
}

function ebayGalleryHints(): GalleryHints {
  return {
    gallerySelectors: EBAY_GALLERY_SELECTORS,
    normalizeImageUrl: normalizeEbayImageUrl,
  };
}

type ExtractionSite = 'ebay' | 'kijiji' | 'generic';

/**
 * Extraction dispatches by the page actually loaded, not by the session's
 * (possibly composite) profile id — the policy layer already decides which
 * hosts are reachable at navigation time, so by the time extract runs on a
 * marketplace page that marketplace was allowed. 'generic' covers test
 * harness profiles and falls through to the historical behavior.
 */
function siteForUrl(pageUrl: string): ExtractionSite {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    if (host === 'kijiji.ca' || host.endsWith('.kijiji.ca')) return 'kijiji';
    if (/(?:^|\.)ebay\.(?:ca|com)$/.test(host)) return 'ebay';
    return 'generic';
  } catch {
    return 'generic';
  }
}

export async function executeCommand(host: ExecutorHost, envelope: CommandEnvelope): Promise<ExecutionOutcome> {
  // §18: expiry is checked immediately before execution.
  if (Date.parse(envelope.expiresAt) <= Date.now()) {
    throw new BridgeError('REQUEST_EXPIRED', undefined, { requestId: envelope.requestId });
  }
  const budget = remainingBudgetMs(envelope);
  const args: unknown = envelope.arguments;

  switch (envelope.command) {
    case 'session_open': {
      const input = SessionOpenInput.parse({ deviceId: envelope.deviceId, ...(args as object) });
      const opened = await host.sessions.open(input.profileName);
      return {
        result: {
          browserSessionHandle: opened.browserSessionHandle,
          deviceId: envelope.deviceId,
          profileName: opened.profileName,
          status: opened.status,
          tabs: opened.tabs,
        },
        pageRevision: null,
        artifacts: [],
      };
    }
    case 'tabs': {
      TabsInput.parse({ browserSessionHandle: envelope.browserSessionHandle });
      const session = host.sessions.resolve(envelope.browserSessionHandle);
      return { result: { tabs: await session.listTabs() }, pageRevision: null, artifacts: [] };
    }
    case 'job_status': {
      // Answered here, above the session queue, on purpose: a poll that
      // enqueued would wait behind the very traversal it is polling and the
      // job would only ever report itself finished. It touches no tab, so
      // it also needs no tabId.
      const input = JobStatusInput.parse({
        browserSessionHandle: envelope.browserSessionHandle,
        ...(args as object),
      });
      host.sessions.resolve(envelope.browserSessionHandle);
      const job = resolveJobStore(host).get(input.jobId, envelope.browserSessionHandle);
      if (job === undefined) {
        throw new BridgeError(
          'ARTIFACT_EXPIRED',
          `Batch job ${input.jobId} is unknown to this session, or its results have aged out.`,
          { jobId: input.jobId },
        );
      }
      return { result: jobProgress(job, input.sinceIndex), pageRevision: null, artifacts: [] };
    }
    default:
      break;
  }

  const session = host.sessions.resolve(envelope.browserSessionHandle);
  const tabId = envelope.tabId;
  if (tabId === null) {
    throw new BridgeError('TAB_NOT_FOUND', 'Command requires a tabId.', { command: envelope.command });
  }

  // A promoted batch has to answer before its own traversal starts, so it
  // cannot be written as the body of an enqueue() the way every other
  // tab command is. It still runs THROUGH the queue — see executeExtractMany.
  if (envelope.command === 'extract_many') {
    return executeExtractMany(host, session, tabId, envelope, budget);
  }

  return session.enqueue(async (): Promise<ExecutionOutcome> => {
    // Re-check expiry once the command reaches the front of the queue (§18).
    if (Date.parse(envelope.expiresAt) <= Date.now()) {
      throw new BridgeError('REQUEST_EXPIRED', undefined, { requestId: envelope.requestId });
    }
    switch (envelope.command) {
      case 'navigate': {
        const input = NavigateInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await navigate(session, tabId, input.url, input.waitUntil, budget);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'snapshot': {
        const input = SnapshotInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await snapshot(session, tabId, input.maxNodes);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'screenshot': {
        const input = ScreenshotInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const capture = await screenshot(session, tabId, input.mode, input.format, input.elementRef, budget);
        const artifactId = newArtifactId();
        return {
          result: {
            artifactId,
            width: capture.width,
            height: capture.height,
            pageRevision: capture.pageRevision,
          },
          pageRevision: capture.pageRevision,
          artifacts: [{ artifactId, mimeType: capture.mimeType, buffer: capture.buffer }],
        };
      }
      case 'images': {
        const input = ImagesInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        // Hint selection follows the loaded page, not the profile id: a
        // composite profile (e.g. ebay+kijiji) still gets eBay hints on
        // eBay pages and generic enumeration elsewhere.
        const hints =
          host.galleryHints ?? (siteForUrl(session.getTab(tabId).page.url()) === 'ebay' ? ebayGalleryHints() : {});
        const outcome = await enumerateImages(session, tabId, input.scope, hints);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'image_get': {
        const input = ImageGetInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const fetched = await fetchImage(session, tabId, input.imageId, budget);
        const artifactId = newArtifactId();
        return {
          result: { artifactId, sourceUrl: fetched.sourceUrl, pageRevision: fetched.pageRevision },
          pageRevision: fetched.pageRevision,
          artifacts: [{ artifactId, mimeType: fetched.mimeType, buffer: fetched.buffer }],
        };
      }
      case 'click': {
        const input = ClickInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await click(session, tabId, input.elementRef, budget);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'fill': {
        const input = FillInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await fill(session, tabId, input.elementRef, input.value, budget);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'select': {
        const input = SelectInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await select(session, tabId, input.elementRef, input.value, budget);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'scroll': {
        const input = ScrollInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await scroll(session, tabId, input.deltaX, input.deltaY, input.elementRef);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'key': {
        const input = KeyInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await pressKey(session, tabId, input.key);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'wait': {
        const input = WaitInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await waitFor(session, tabId, input.condition, Math.min(input.timeoutMs, budget));
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      case 'extract': {
        // The gateway threads the deployment-authoritative destination on
        // the wire envelope (audit F-09); it is not part of the public
        // tool schema, so strip it before normative validation.
        const { destinationPostalCode, ...toolArgs } = args as Record<string, unknown>;
        const input = ExtractInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...toolArgs,
        });
        const expectedPostal =
          typeof destinationPostalCode === 'string' && destinationPostalCode.length > 0
            ? destinationPostalCode
            : host.expectedPostalCode;
        return executeExtract(host, session, tabId, expectedPostal, input.siteProfile, input.search);
      }
      case 'open_and_extract': {
        // Same F-09 treatment as extract: the destination rides the
        // envelope, never the public schema.
        const { destinationPostalCode, ...toolArgs } = args as Record<string, unknown>;
        const input = OpenAndExtractInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...toolArgs,
        });
        const expectedPostal =
          typeof destinationPostalCode === 'string' && destinationPostalCode.length > 0
            ? destinationPostalCode
            : host.expectedPostalCode;
        // The one and only navigation primitive: the local URL allowlist,
        // the private-network rules and the redirect revalidation all live
        // behind it (packages/browser-core/src/session.ts navigate()).
        const nav = await navigate(session, tabId, input.url, input.waitUntil, budget);
        // Unlike browser.extract, an omitted `search` here means "compact
        // with the defaults": this tool exists to stop a results page
        // arriving as a hundred kilobytes of candidate rows.
        const outcome = await executeExtract(
          host,
          session,
          tabId,
          expectedPostal,
          input.siteProfile,
          input.search ?? DEFAULT_SEARCH_COMPACTION,
        );
        return {
          result: {
            ...outcome.result,
            finalUrl: nav.finalUrl,
            navigationStatus: nav.navigationStatus,
          },
          pageRevision: outcome.pageRevision,
          artifacts: [],
        };
      }
      case 'handoff': {
        const input = HandoffInput.parse({
          browserSessionHandle: envelope.browserSessionHandle,
          tabId,
          ...(args as object),
        });
        const outcome = await handoff(session, tabId, input.message, input.timeoutSeconds);
        return { result: { ...outcome }, pageRevision: outcome.pageRevision, artifacts: [] };
      }
      default:
        throw new BridgeError('INTERNAL_ERROR', `Unknown command "${envelope.command}".`, {
          command: envelope.command,
        });
    }
  });
}

async function executeExtract(
  host: ExecutorHost,
  session: BrowserSessionRuntime,
  tabId: string,
  expectedPostalCode: string = host.expectedPostalCode,
  declaredSiteProfile: string = EBAY_SITE_PROFILE_ID,
  /** Present only when the caller asked for a reduced candidate list. */
  searchOptions?: SearchCompaction,
): Promise<ExecutionOutcome> {
  const tab = session.getTab(tabId);
  const pageUrl = tab.page.url();
  const site = siteForUrl(pageUrl);

  // The declared siteProfile is caller intent; the page decides what runs.
  // A mismatch is a warning, never a refusal — the scheduled research runs
  // hop between marketplaces inside one session.
  const intentWarnings: string[] = [];
  if (site !== 'generic') {
    const activeProfile = site === 'kijiji' ? KIJIJI_SITE_PROFILE_ID : EBAY_SITE_PROFILE_ID;
    if (declaredSiteProfile !== activeProfile) {
      intentWarnings.push(
        `DECLARED_SITE_PROFILE_MISMATCH: extraction ran ${activeProfile} for ${pageUrl}; the call declared ${declaredSiteProfile}.`,
      );
    }
  }

  if (site === 'kijiji') {
    const kind = classifyKijijiPage(pageUrl);
    const html = await tab.page.content();
    const { document } = parseHTML(html);
    // 'other' is not a refusal: run the same ad-link scan the search pages
    // use. Worst case it finds nothing and says so.
    if (kind === 'search' || kind === 'other') {
      const searchPage = extractSearchResults(document as unknown as Document, pageUrl);
      const warnings = [...intentWarnings];
      if (kind === 'other') {
        warnings.push(
          `UNCLASSIFIED_PAGE: ${pageUrl} is not a Kijiji ad or search URL; returned a best-effort ad-link scan. An empty candidate list here may mean the page has no ads, not that extraction failed.`,
        );
      }
      if (searchPage.results.length === 0) {
        warnings.push(
          'NO_LISTING_CANDIDATES: no ad links found — an empty results page, or the result-card selectors need updating.',
        );
      }
      const kijijiPage = applySearchCompaction(
        {
          siteProfile: KIJIJI_SITE_PROFILE_ID,
          pageKind: kind,
          pageUrl,
          candidateCount: searchPage.results.length,
          candidates: searchPage.results,
          hasNextPage: searchPage.hasNextPage,
          nextPageUrl: searchPage.nextPageUrl,
          totalResults: searchPage.totalResults,
          note: 'Candidate snippets are traversal hints; open each ad URL and extract it for canonical evidence.',
        },
        searchOptions,
        warnings,
      );
      return {
        result: {
          siteProfile: KIJIJI_SITE_PROFILE_ID,
          pageRevision: tab.revision,
          record: kijijiPage.record,
          warnings: kijijiPage.warnings,
        },
        pageRevision: tab.revision,
        artifacts: [],
      };
    }
    const { record, warnings } = extractKijijiListing(document as unknown as Document, pageUrl, {
      pageRevision: tab.revision,
    });
    return {
      result: {
        siteProfile: record.siteProfile,
        pageRevision: tab.revision,
        record: record as unknown as Record<string, unknown>,
        warnings: [...intentWarnings, ...warnings],
      },
      pageRevision: tab.revision,
      artifacts: [],
    };
  }

  // eBay pages dispatch by kind (FR-15); 'generic' hosts (test-harness
  // profiles) keep the historical straight-to-listing-extractor path.
  // Page kind selects an extractor; it never refuses a page. Anything that
  // is not an item page gets the /itm/-link scan, including 'other'.
  const kind = site === 'ebay' ? classifyEbayPage(pageUrl) : ('listing' as const);
  if (kind === 'search' || kind === 'store' || kind === 'other') {
    const html = await tab.page.content();
    const { document } = parseHTML(html);
    const candidates = extractListingCandidates(document as unknown as Document, pageUrl);
    const warnings = [...intentWarnings];
    if (kind === 'other') {
      warnings.push(
        `UNCLASSIFIED_PAGE: ${pageUrl} is not an item (/itm/), search (/sch/) or store (/str/, /usr/) URL; returned a best-effort /itm/-link scan. An empty candidate list here may mean the page has no listings, not that extraction failed.`,
      );
    }
    if (candidates.length === 0) {
      warnings.push(
        'NO_LISTING_CANDIDATES: no /itm/ links found — an empty results page, or the result-card selectors need updating.',
      );
    }
    const ebayPage = applySearchCompaction(
      {
        siteProfile: EBAY_SITE_PROFILE_ID,
        pageKind: kind,
        pageUrl,
        candidateCount: candidates.length,
        candidates,
        note: 'Candidate snippets are traversal hints; open each /itm/ URL and extract it for canonical evidence.',
      },
      searchOptions,
      warnings,
    );
    return {
      result: {
        siteProfile: EBAY_SITE_PROFILE_ID,
        pageRevision: tab.revision,
        record: ebayPage.record,
        warnings: ebayPage.warnings,
      },
      pageRevision: tab.revision,
      artifacts: [],
    };
  }
  // §20.1: verify/set destination through reversible controls before
  // marking shipping destination-resolved.
  let verifiedDestination: { postalCode: string; verified: boolean } | undefined;
  if (site === 'ebay' && isListingPage(pageUrl)) {
    const outcome = await ensureDestination(session, tabId, expectedPostalCode, host.logger);
    verifiedDestination =
      outcome.postalCode === null
        ? { postalCode: '', verified: false }
        : { postalCode: outcome.postalCode, verified: outcome.verified };
  }

  const html = await tab.page.content();
  const { document } = parseHTML(html);
  const { record, warnings } = extractListing(document as unknown as Document, pageUrl, {
    expectedPostalCode,
    verifiedDestination,
    pageRevision: tab.revision,
  });

  const allWarnings = [...intentWarnings, ...warnings];
  if (verifiedDestination !== undefined && !verifiedDestination.verified) {
    allWarnings.push('DESTINATION_UNVERIFIED');
  }
  return {
    result: {
      siteProfile: record.siteProfile,
      pageRevision: tab.revision,
      record: record as unknown as Record<string, unknown>,
      warnings: allWarnings,
    },
    pageRevision: tab.revision,
    artifacts: [],
  };
}

/**
 * Apply the caller's candidate reduction, or leave the record exactly as
 * Phase 1 produced it when no reduction was asked for. The absent case is
 * load-bearing: browser.extract with no `search` must keep returning the
 * bytes it always returned.
 */
function applySearchCompaction(
  record: Record<string, unknown>,
  searchOptions: SearchCompaction | undefined,
  warnings: string[],
): { record: Record<string, unknown>; warnings: string[] } {
  if (searchOptions === undefined) return { record, warnings };
  const compacted = compactSearchPage(record, searchOptions);
  return { record: compacted.record, warnings: [...warnings, ...compacted.warnings] };
}

/**
 * Traverse one URL: navigate, then extract, and turn any failure into this
 * URL's own result slot instead of the batch's.
 *
 * The navigation goes through browser-core's navigate() — the same call
 * browser.navigate makes — so `session.policy.assertUrlAllowed(url,
 * 'navigation')` runs for every URL in the batch, and the context-level
 * route interception revalidates every redirect hop and aborts protected
 * endpoints underneath it. There is deliberately no second navigation path
 * in this file: a batch tool that reimplemented navigation would be a way
 * to reach a URL that browser.navigate refuses.
 */
async function traverseOne(
  host: ExecutorHost,
  session: BrowserSessionRuntime,
  tabId: string,
  url: string,
  waitUntil: 'domcontentloaded' | 'load',
  siteProfile: string,
  expectedPostalCode: string,
  compact: boolean,
  budgetMs: number,
): Promise<BatchExtractItem> {
  try {
    const nav = await navigate(session, tabId, url, waitUntil, budgetMs);
    const outcome = await executeExtract(host, session, tabId, expectedPostalCode, siteProfile);
    const result = outcome.result;
    const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
    const profile = typeof result.siteProfile === 'string' ? result.siteProfile : siteProfile;
    const record = (result.record ?? null) as Record<string, unknown> | null;
    return {
      url,
      finalUrl: nav.finalUrl,
      ok: true,
      siteProfile: profile,
      pageRevision: outcome.pageRevision,
      record: record === null ? null : compact ? compactItemRecord(profile, record, warnings) : record,
      warnings,
      error: null,
    };
  } catch (err) {
    const bridgeError = BridgeError.from(err);
    host.logger.warn({ url, code: bridgeError.code }, 'Batch traversal item failed');
    return {
      url,
      finalUrl: null,
      ok: false,
      siteProfile: null,
      pageRevision: null,
      record: null,
      warnings: [],
      error: {
        code: bridgeError.code,
        message: bridgeError.message,
        retryable: bridgeError.retryable,
      },
    };
  }
}

interface BatchPlan {
  urls: string[];
  waitUntil: 'domcontentloaded' | 'load';
  siteProfile: string;
  expectedPostalCode: string;
  compact: boolean;
}

/**
 * Walk a batch to completion, or until `deadlineAt` passes. Stopping early
 * is reported as 'partial' rather than as an error: the slots already
 * produced are real evidence and throwing them away to raise a timeout
 * would be the Phase 1 failure mode in a new costume.
 */
async function runBatch(
  host: ExecutorHost,
  session: BrowserSessionRuntime,
  tabId: string,
  plan: BatchPlan,
  deadlineAt: number,
  onItem: (item: BatchExtractItem) => void,
): Promise<'completed' | 'partial'> {
  for (const url of plan.urls) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return 'partial';
    const item = await traverseOne(
      host,
      session,
      tabId,
      url,
      plan.waitUntil,
      plan.siteProfile,
      plan.expectedPostalCode,
      plan.compact,
      Math.min(BATCH_ITEM_BUDGET_MS, remaining),
    );
    onItem(item);
  }
  return 'completed';
}

function inlineProgress(
  status: 'completed' | 'partial',
  requested: number,
  compact: boolean,
  results: BatchExtractItem[],
  warnings: string[],
): Record<string, unknown> {
  return {
    mode: 'inline',
    jobId: null,
    status,
    requested,
    completed: results.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    compact,
    resultsFrom: 0,
    results,
    warnings,
  };
}

async function executeExtractMany(
  host: ExecutorHost,
  session: BrowserSessionRuntime,
  tabId: string,
  envelope: CommandEnvelope,
  budget: number,
): Promise<ExecutionOutcome> {
  const { destinationPostalCode, ...toolArgs } = envelope.arguments as Record<string, unknown>;
  const input = ExtractManyInput.parse({
    browserSessionHandle: envelope.browserSessionHandle,
    tabId,
    ...toolArgs,
  });
  const expectedPostalCode =
    typeof destinationPostalCode === 'string' && destinationPostalCode.length > 0
      ? destinationPostalCode
      : host.expectedPostalCode;

  const warnings: string[] = [];
  if (input.concurrency > 1) {
    // Honest refusal rather than silent compliance: a session executes its
    // commands through one FIFO queue (packages/browser-core/src/session.ts
    // enqueue()) and a batch drives one tab, so parallel traversal would
    // mean opening tabs outside the queue's knowledge.
    warnings.push(
      `CONCURRENCY_COERCED: concurrency ${input.concurrency} was requested; this session executes commands serially through one tab, so the batch ran sequentially.`,
    );
  }

  const plan: BatchPlan = {
    urls: input.urls,
    waitUntil: input.waitUntil,
    siteProfile: input.siteProfile,
    expectedPostalCode,
    compact: input.compact,
  };

  // §18 promotion rule: 'auto' answers inline only for a batch that fits
  // this tool's own catalog deadline at the catalog's per-item charge
  // (MAX_INLINE_BATCH_ITEMS, derived in packages/protocol/src/catalog.ts).
  const resolvedMode =
    input.mode === 'auto' ? (input.urls.length <= MAX_INLINE_BATCH_ITEMS ? 'inline' : 'job') : input.mode;

  if (resolvedMode === 'inline') {
    return session.enqueue(async (): Promise<ExecutionOutcome> => {
      if (Date.parse(envelope.expiresAt) <= Date.now()) {
        throw new BridgeError('REQUEST_EXPIRED', undefined, { requestId: envelope.requestId });
      }
      const results: BatchExtractItem[] = [];
      const status = await runBatch(host, session, tabId, plan, Date.now() + budget, (item) => {
        results.push(item);
      });
      if (status === 'partial') {
        warnings.push(
          `BATCH_DEADLINE_REACHED: ${results.length} of ${input.urls.length} URLs were traversed before the call's deadline; re-issue the remainder, or use mode "job".`,
        );
      }
      return {
        result: inlineProgress(status, input.urls.length, input.compact, results, warnings),
        pageRevision: results.at(-1)?.pageRevision ?? null,
        artifacts: [],
      };
    });
  }

  const store = resolveJobStore(host);
  const job: BatchJob = store.create(
    envelope.browserSessionHandle,
    input.urls.length,
    input.compact,
    warnings,
  );
  // Queued, not detached: the traversal still takes its turn behind
  // whatever the session is already doing, so a job never races another
  // command for the tab. What the job does NOT do is hold this response
  // open — that is the whole point of promoting it.
  void session
    .enqueue(async () => {
      const status = await runBatch(
        host,
        session,
        tabId,
        plan,
        job.startedAt + BATCH_JOB_DEADLINE_MS,
        (item) => {
          store.append(job.jobId, item);
        },
      );
      store.finish(
        job.jobId,
        status,
        status === 'partial'
          ? [
              `BATCH_DEADLINE_REACHED: the job stopped after ${job.results.length} of ${job.requested} URLs; re-issue the remainder.`,
            ]
          : [],
      );
    })
    .catch((err: unknown) => {
      // A whole-batch failure (the session died, the tab closed) still has
      // to reach the poller, so it is recorded as the job's outcome.
      const bridgeError = BridgeError.from(err);
      host.logger.error({ jobId: job.jobId, code: bridgeError.code }, 'Batch job failed');
      store.finish(job.jobId, 'partial', [`BATCH_FAILED: ${bridgeError.code}: ${bridgeError.message}`]);
    });

  return { result: jobProgress(job), pageRevision: null, artifacts: [] };
}
