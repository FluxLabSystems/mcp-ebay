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
  adIdFromUrl,
  classifyKijijiPage,
  extractKijijiListing,
  extractSearchResults,
  isKijijiAdImageUrl,
  KIJIJI_GALLERY_SELECTORS,
  KIJIJI_SITE_PROFILE_ID,
  kijijiSearchUrlWarnings,
  normalizeKijijiImageUrl,
} from '@browser-bridge/site-kijiji';
import { isWardrobeVendorHost, WARDROBE_VENDORS_SITE_PROFILE_ID } from '@browser-bridge/site-vendors';
import {
  classifyZazzlePage,
  extractZazzleProduct,
  extractZazzleSearchResults,
  ZAZZLE_SITE_PROFILE_ID,
} from '@browser-bridge/site-zazzle';
import { resolveDirtyRevision, type BrowserSessionRuntime, type TabState } from '@browser-bridge/browser-core';
import { challengeWarning, CHALLENGE_WARNING_PREFIX, detectChallengePage } from './challenge.js';
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

function kijijiGalleryHints(): GalleryHints {
  return {
    gallerySelectors: KIJIJI_GALLERY_SELECTORS,
    normalizeImageUrl: normalizeKijijiImageUrl,
    isGalleryImage: isKijijiAdImageUrl,
  };
}

type ExtractionSite = 'ebay' | 'kijiji' | 'zazzle' | 'vendor' | 'generic';

/**
 * Extraction dispatches by the page actually loaded, not by the session's
 * (possibly composite) profile id — the policy layer already decides which
 * hosts are reachable at navigation time, so by the time extract runs on a
 * marketplace page that marketplace was allowed. 'generic' covers test
 * harness profiles and falls through to the historical behavior.
 */
/** A curated Zazzle category (/c/…) page, as opposed to a keyword search (/s/…). */
function isZazzleCategoryPath(pageUrl: string): boolean {
  try {
    return /^\/c\//.test(new URL(pageUrl).pathname);
  } catch {
    return false;
  }
}

function siteForUrl(pageUrl: string): ExtractionSite {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    if (host === 'kijiji.ca' || host.endsWith('.kijiji.ca')) return 'kijiji';
    if (/(?:^|\.)ebay\.(?:ca|com)$/.test(host)) return 'ebay';
    if (/(?:^|\.)zazzle\.(?:com|ca)$/.test(host)) return 'zazzle';
    // Policy-only wardrobe vendor roster: reachable, but no extractor.
    if (isWardrobeVendorHost(host)) return 'vendor';
    return 'generic';
  } catch {
    return 'generic';
  }
}

/**
 * The extraction source one revision vouches for (defects B1/B2). The first
 * extract at a (tab, revision) captures page.content() ONCE and pins it;
 * every later extract at the same revision parses the SAME string, so
 * identical calls return identical payloads and offset/limit paging walks
 * one coherent list — a live marketplace page rewrites its own result cards
 * continuously, and re-serializing per call is what made identical calls
 * disagree while pageRevision sat still. A mutating action resolves to a
 * revision bump here exactly as it does in snapshot (§14 shared rule), which
 * also invalidates the pin.
 */
interface ExtractionSource {
  document: Document;
  /** Instant the pinned HTML was captured; extraction observedAt derives from it. */
  capturedAt: Date;
  /** True when this call was served from an existing pin. */
  pinned: boolean;
}

async function resolveExtractionSource(tab: TabState): Promise<ExtractionSource> {
  resolveDirtyRevision(tab);
  const pin = tab.extractionPin;
  if (pin !== null && pin !== undefined && pin.revision === tab.revision) {
    const { document } = parseHTML(pin.html);
    return { document: document as unknown as Document, capturedAt: new Date(pin.capturedAt), pinned: true };
  }
  const html = await tab.page.content();
  const capturedAt = new Date();
  tab.extractionPin = { revision: tab.revision, html, capturedAt: capturedAt.toISOString() };
  const { document } = parseHTML(html);
  return { document: document as unknown as Document, capturedAt, pinned: false };
}

/**
 * Deterministic fingerprint of what a given HTML serialization EXTRACTS to,
 * with all time-derived fields held at a fixed instant so only DOM-derived
 * content participates. Used by the browser_wait drift check: cosmetic churn
 * (tracking params, timers, ad rotation) must not bump pageRevision, while a
 * change to any extractable field must.
 */
const FINGERPRINT_EPOCH = new Date('2000-01-01T00:00:00.000Z');

function extractionFingerprint(html: string, pageUrl: string): string {
  const site = siteForUrl(pageUrl);
  try {
    const { document } = parseHTML(html);
    const doc = document as unknown as Document;
    if (site === 'kijiji') {
      if (classifyKijijiPage(pageUrl) === 'listing') {
        return JSON.stringify(extractKijijiListing(doc, pageUrl, { observedAt: FINGERPRINT_EPOCH }).record);
      }
      return JSON.stringify(extractSearchResults(doc, pageUrl, { observedAt: FINGERPRINT_EPOCH }));
    }
    if (site === 'ebay') {
      if (classifyEbayPage(pageUrl) === 'listing') {
        return JSON.stringify(extractListing(doc, pageUrl, { observedAt: FINGERPRINT_EPOCH }).record);
      }
      return JSON.stringify(extractListingCandidates(doc, pageUrl));
    }
    if (site === 'zazzle') {
      if (classifyZazzlePage(pageUrl) === 'product') {
        return JSON.stringify(extractZazzleProduct(doc, pageUrl, { observedAt: FINGERPRINT_EPOCH }).record);
      }
      return JSON.stringify(extractZazzleSearchResults(doc, pageUrl));
    }
  } catch {
    // Fall through to the byte comparison below.
  }
  // Generic pages have no extractor semantics; the bytes are the content.
  return html;
}

/**
 * browser_wait doubles as the caller's explicit "let the page move on"
 * primitive, so after the condition holds it is the one place a
 * spontaneous page change is allowed to surface: if the extractable content
 * has drifted from the pinned source, the revision bumps and the pin is
 * re-captured — the caller sees the bump in the wait result and knows to
 * re-extract. Without this, "extract → wait → extract" either lied (same
 * revision, different data) or froze (pin served forever).
 */
async function refreshExtractionPinAfterWait(tab: TabState): Promise<number | null> {
  const pin = tab.extractionPin;
  if (pin === null || pin === undefined || pin.revision !== tab.revision) return null;
  const freshHtml = await tab.page.content();
  if (freshHtml === pin.html) return null;
  const pageUrl = tab.page.url();
  pin.fingerprint ??= extractionFingerprint(pin.html, pageUrl);
  if (extractionFingerprint(freshHtml, pageUrl) === pin.fingerprint) return null;
  tab.revision += 1;
  tab.dirty = false;
  tab.extractionPin = { revision: tab.revision, html: freshHtml, capturedAt: new Date().toISOString() };
  return tab.revision;
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
        const capture = await screenshot(session, tabId, input.mode, input.format, input.elementRef, budget, input.scale);
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
        // composite profile (e.g. ebay+kijiji) still gets each site's hints
        // on its own pages and generic enumeration elsewhere. Kijiji used to
        // fall to {} here, which silently turned scope "gallery" into a
        // whole-page img scan — six ad photos plus a store badge.
        const imagesSite = siteForUrl(session.getTab(tabId).page.url());
        const hints =
          host.galleryHints ??
          (imagesSite === 'ebay' ? ebayGalleryHints() : imagesSite === 'kijiji' ? kijijiGalleryHints() : {});
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
        // B2: a satisfied wait is the explicit refresh point — if the page's
        // extractable content moved on from the pinned source, bump the
        // revision so the caller can SEE staleness instead of re-extracting
        // identical-revision data that silently differs.
        const bumped = await refreshExtractionPinAfterWait(session.getTab(tabId));
        const pageRevision = bumped ?? outcome.pageRevision;
        return { result: { ...outcome, pageRevision }, pageRevision, artifacts: [] };
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
        // Unlike browser_extract, an omitted `search` here means "compact
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
    const activeProfile =
      site === 'kijiji'
        ? KIJIJI_SITE_PROFILE_ID
        : site === 'zazzle'
          ? ZAZZLE_SITE_PROFILE_ID
          : site === 'vendor'
            ? WARDROBE_VENDORS_SITE_PROFILE_ID
            : EBAY_SITE_PROFILE_ID;
    if (declaredSiteProfile !== activeProfile) {
      intentWarnings.push(
        `DECLARED_SITE_PROFILE_MISMATCH: extraction ran ${activeProfile} for ${pageUrl}; the call declared ${declaredSiteProfile}.`,
      );
    }
  }

  // B1: one pinned serialization per (tab, revision) — identical calls at
  // the same revision extract from the same bytes.
  const source = await resolveExtractionSource(tab);
  const document = source.document;

  // C5: a bot wall is not the page the caller asked about, and it is
  // retryable where a dead listing is not. Detect it before any site
  // extractor runs so its half-empty shell never masquerades as evidence.
  const challenge = detectChallengePage(document, pageUrl);
  if (challenge !== null) {
    const activeProfile =
      site === 'kijiji'
        ? KIJIJI_SITE_PROFILE_ID
        : site === 'ebay'
          ? EBAY_SITE_PROFILE_ID
          : site === 'zazzle'
            ? ZAZZLE_SITE_PROFILE_ID
            : site === 'vendor'
              ? WARDROBE_VENDORS_SITE_PROFILE_ID
              : declaredSiteProfile;
    return {
      result: {
        siteProfile: activeProfile,
        pageRevision: tab.revision,
        record: {
          pageKind: 'challenge',
          pageUrl,
          challengeVendor: challenge.vendor,
          observedAt: source.capturedAt.toISOString(),
        },
        warnings: [...intentWarnings, challengeWarning(challenge)],
      },
      pageRevision: tab.revision,
      artifacts: [],
    };
  }

  // wardrobe-vendors.v1 is a policy-only profile: its hosts are reachable
  // for navigate/snapshot/click/screenshot, but nothing here knows their
  // page structure. Before this branch a vendor page fell through to the
  // eBay listing extractor and came back as an all-null eBay record —
  // plausible-looking junk. Say so instead, and hand back the little that
  // is host-independent: the page's own title and URL.
  if (site === 'vendor') {
    return {
      result: {
        siteProfile: WARDROBE_VENDORS_SITE_PROFILE_ID,
        pageRevision: tab.revision,
        record: {
          siteProfile: WARDROBE_VENDORS_SITE_PROFILE_ID,
          pageKind: 'other',
          pageUrl,
          pageTitle: normalizeTitle(document.querySelector('title')?.textContent),
          observedAt: source.capturedAt.toISOString(),
        },
        warnings: [
          ...intentWarnings,
          `NO_EXTRACTOR_FOR_HOST: ${pageUrl} is on the wardrobe-vendors.v1 roster, which is policy-only — no extractor exists for this vendor. Read the page with browser_snapshot (structure, prices, personalization controls) or browser_screenshot; every value must be recorded with its provenance as observed on the page, never inferred from this record.`,
        ],
      },
      pageRevision: tab.revision,
      artifacts: [],
    };
  }

  if (site === 'kijiji') {
    const kind = classifyKijijiPage(pageUrl);
    // 'other' is not a refusal: run the same ad-link scan the search pages
    // use. Worst case it finds nothing and says so.
    if (kind === 'search' || kind === 'other') {
      const searchPage = extractSearchResults(document, pageUrl, { observedAt: source.capturedAt });
      // radius=/address= are ignored by kijiji.ca (2026-09-02, isolated
      // live); a URL that still carries them must not be read as a radius
      // sweep.
      const warnings = [...intentWarnings, ...kijijiSearchUrlWarnings(pageUrl)];
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
          observedAt: source.capturedAt.toISOString(),
          candidateCount: searchPage.results.length,
          candidates: searchPage.results,
          hasNextPage: searchPage.hasNextPage,
          nextPageUrl: searchPage.nextPageUrl,
          totalResults: searchPage.totalResults,
          // The rendered <title> is the sole accepted proof of which region an
          // l<regionId> scopes; it survives compaction as a passthrough root.
          pageTitle: searchPage.pageTitle,
          // The removed-ad marker: a deleted ad's VIP URL 302s to this
          // search page carrying ?adRemoved=<id>. Dropping it here made the
          // redirect indistinguishable from an ordinary search landing.
          removedAdId: searchPage.removedAdId,
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
    const { record, warnings } = extractKijijiListing(document, pageUrl, {
      pageRevision: tab.revision,
      observedAt: source.capturedAt,
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

  if (site === 'zazzle') {
    const kind = classifyZazzlePage(pageUrl);
    if (kind === 'search' || kind === 'other') {
      const searchPage = extractZazzleSearchResults(document, pageUrl);
      const warnings = [...intentWarnings];
      if (kind === 'other') {
        warnings.push(
          `UNCLASSIFIED_PAGE: ${pageUrl} is not a Zazzle product (…-<18-digit id>) or search (/s/, /c/) URL; returned a best-effort product-link scan. An empty candidate list here may mean the page has no products, not that extraction failed.`,
        );
      }
      if (searchPage.noResultsShell && isZazzleCategoryPath(pageUrl)) {
        // Observed live 2026-09-03 (wardrobe Lane B fire): /c/hats committed
        // with its real category title and rendered the no-results shell
        // with no product grid at all, while product pages on the same host
        // extracted normally in the same session. A curated category cannot
        // legitimately have zero products, so this is the listing grid not
        // being served to this browser — a coverage boundary to record once,
        // not a search miss to retry through another route.
        warnings.push(
          'CATEGORY_EMPTY_SHELL: a curated /c/ category page rendered Zazzle\'s no-results shell with no product grid. A category cannot legitimately have zero products, so the listing grid is not being served to this browser (bot, consent or hydration gating — root cause unverified). Record it once per fire as a listing-surface coverage boundary, keep extracting product pages (they are unaffected), and do not spend the budget re-driving the search box or /s/ deep links for the same query.',
        );
      } else if (searchPage.noResultsShell) {
        // Observed live 2026-09-01: a /s/ deep link can render this shell
        // while the same query driven through the search box returns a full
        // page, so an empty shell is ambiguous between a true zero and
        // deep-link gating. Observed live 2026-09-03: the search box and the
        // deep link can ALSO dead-end on the same shell, so the remedy must
        // say where that ends instead of prescribing the route that produced
        // the page.
        warnings.push(
          'SEARCH_EMPTY_SHELL: the page says the search did not match any products. On Zazzle a /s/ deep link can render this shell even when the query has results — if this page came from a deep link, navigate to the storefront and drive the search box (browser_fill + Enter) with the same query before recording zero coverage. If this page came from the search box, or the search box lands on the same shell, the listing grid is not being served to this browser: record that once per fire as a listing-surface coverage boundary (a /c/ category page will show the same, as CATEGORY_EMPTY_SHELL) and keep extracting product pages.',
        );
      } else if (searchPage.results.length === 0) {
        warnings.push(
          'NO_LISTING_CANDIDATES: no product links found — an empty results page, or the result-card selectors need updating.',
        );
      }
      const zazzlePage = applySearchCompaction(
        {
          siteProfile: ZAZZLE_SITE_PROFILE_ID,
          pageKind: kind,
          pageUrl,
          observedAt: source.capturedAt.toISOString(),
          candidateCount: searchPage.results.length,
          candidates: searchPage.results,
          noResultsShell: searchPage.noResultsShell,
          note: 'Candidate snippets are traversal hints (snippet currency comes from an explicit C$/US$ prefix or the storefront TLD); open each product URL and extract it for canonical evidence.',
        },
        searchOptions,
        warnings,
      );
      return {
        result: {
          siteProfile: ZAZZLE_SITE_PROFILE_ID,
          pageRevision: tab.revision,
          record: zazzlePage.record,
          warnings: zazzlePage.warnings,
        },
        pageRevision: tab.revision,
        artifacts: [],
      };
    }
    const { record, warnings } = extractZazzleProduct(document, pageUrl, {
      pageRevision: tab.revision,
      observedAt: source.capturedAt,
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
    const candidates = extractListingCandidates(document, pageUrl);
    const warnings = [...intentWarnings];
    if (kind === 'other') {
      warnings.push(
        `UNCLASSIFIED_PAGE: ${pageUrl} is not an item (/itm/), search (/sch/) or store (/str/, /usr/) URL; returned a best-effort /itm/-link scan. An empty candidate list here may mean the page has no listings, not that extraction failed.`,
      );
    }
    const pageTitle = normalizeTitle(document.querySelector('title')?.textContent);
    if (candidates.length === 0 && kind === 'store') {
      // A seller page with nothing to list is two different things: a live
      // store with no active listings (the seller header still renders and
      // titles the page) or an unavailable/suspended profile, which the
      // 2026-09-02 deals fire saw render eBay's "Attention" error template
      // with an EMPTY <title>. The generic candidate miss hid that
      // difference; the title is the cheapest signal that separates them.
      // NEEDS-LIVE-VERIFICATION: no live /usr/ page has been captured as a
      // fixture yet, so this reports the title rather than classifying.
      warnings.push(
        pageTitle.length === 0
          ? `STORE_NO_CANDIDATES: no /itm/ links on ${pageUrl} and the page has an empty <title> — consistent with eBay's error template for an unavailable or suspended profile rather than a live store with no listings. Confirm with browser_snapshot before treating the seller as gone.`
          : `STORE_NO_CANDIDATES: no /itm/ links on ${pageUrl}; the page titles itself "${pageTitle}", so the profile rendered but no active listings were found (or the store-card selectors need updating).`,
      );
    } else if (candidates.length === 0) {
      warnings.push(
        'NO_LISTING_CANDIDATES: no /itm/ links found — an empty results page, or the result-card selectors need updating.',
      );
    }
    const ebayPage = applySearchCompaction(
      {
        siteProfile: EBAY_SITE_PROFILE_ID,
        pageKind: kind,
        pageUrl,
        pageTitle,
        observedAt: source.capturedAt.toISOString(),
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
  // marking shipping destination-resolved. This runs AFTER the challenge
  // check on purpose — the bridge never pokes controls on a bot wall — and
  // its raw locator interactions bypass the browser-core dirty flag, so a
  // set attempt resolves to a fresh revision by hand before re-capturing.
  let verifiedDestination: { postalCode: string; verified: boolean } | undefined;
  let listingSource = source;
  if (site === 'ebay' && isListingPage(pageUrl)) {
    const outcome = await ensureDestination(session, tabId, expectedPostalCode, host.logger);
    verifiedDestination =
      outcome.postalCode === null
        ? { postalCode: '', verified: false }
        : { postalCode: outcome.postalCode, verified: outcome.verified };
    if (outcome.attemptedSet) {
      tab.revision += 1;
      tab.dirty = false;
      tab.extractionPin = null;
    }
    // No-op when nothing above invalidated the pin; a fresh capture when
    // the destination flow (or a navigation it triggered) moved the page.
    listingSource = await resolveExtractionSource(tab);
  }

  const { record, warnings } = extractListing(listingSource.document, pageUrl, {
    expectedPostalCode,
    verifiedDestination,
    pageRevision: tab.revision,
    observedAt: listingSource.capturedAt,
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
 * load-bearing: browser_extract with no `search` must keep returning the
 * bytes it always returned.
 */
function normalizeTitle(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

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
 * A slot whose page answered but is not a listing: eBay's error or
 * removed-item template (listingStatus 'unavailable'), a deleted Kijiji ad
 * still rendering a VIP shell (listingStatus 'deleted'), or Kijiji's
 * removed-ad redirect — the VIP URL 302s to its category search page
 * carrying ?adRemoved=<id>. These used to come back ok:true and count as
 * succeeded, so a routine upserting every ok slot would write a record
 * literally titled "Discover error" to the deals board. The record stays on
 * the slot — a dead listing is exactly the evidence a re-validation pass
 * needs to retire a stored id — but ok now means "produced listing
 * evidence", not "the tab loaded something".
 *
 * 'sold', 'ended' and 'expired' stay ok:true on purpose: those are real
 * listing pages whose data (final price, close date) is the signal a deals
 * watch exists to collect.
 */
function deadListingError(url: string, record: Record<string, unknown> | null): BatchExtractItem['error'] {
  if (record === null) return null;
  const status = typeof record.listingStatus === 'string' ? record.listingStatus : null;
  if (status === 'unavailable' || status === 'deleted') {
    return {
      code: 'LISTING_UNAVAILABLE',
      message: `The page reports listingStatus "${status}" — an error, removed-listing, or deleted-ad page, not listing evidence.`,
      retryable: false,
    };
  }
  const removedAdId = typeof record.removedAdId === 'string' ? record.removedAdId : null;
  if (removedAdId !== null && removedAdId === adIdFromUrl(url)) {
    return {
      code: 'LISTING_UNAVAILABLE',
      message: `Kijiji redirected this ad to its category search page marked adRemoved=${removedAdId}: the ad no longer exists.`,
      retryable: false,
    };
  }
  return null;
}

/**
 * Traverse one URL: navigate, then extract, and turn any failure into this
 * URL's own result slot instead of the batch's.
 *
 * The navigation goes through browser-core's navigate() — the same call
 * browser_navigate makes — so `session.policy.assertUrlAllowed(url,
 * 'navigation')` runs for every URL in the batch, and the context-level
 * route interception revalidates every redirect hop and aborts protected
 * endpoints underneath it. There is deliberately no second navigation path
 * in this file: a batch tool that reimplemented navigation would be a way
 * to reach a URL that browser_navigate refuses.
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
    // A bot wall outranks every other page classification: it is retryable
    // where a dead listing is not, and its half-rendered shell must never be
    // scored as (or retire) listing evidence.
    const challengeNote = warnings.find((warning) => warning.startsWith(`${CHALLENGE_WARNING_PREFIX}:`));
    const error: BatchExtractItem['error'] =
      challengeNote !== undefined
        ? { code: 'CHALLENGE_PAGE', message: challengeNote, retryable: true }
        : deadListingError(url, record);
    return {
      url,
      finalUrl: nav.finalUrl,
      ok: error === null,
      siteProfile: profile,
      pageRevision: outcome.pageRevision,
      record: record === null ? null : compact ? compactItemRecord(profile, record, warnings) : record,
      warnings,
      error,
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
  // B5: a batch traverses each unique URL once. The same URL twice bought
  // two full navigations for one answer at 25-URL batch scale.
  const uniqueUrls = [...new Set(input.urls)];
  if (uniqueUrls.length < input.urls.length) {
    warnings.push(
      `DUPLICATE_URLS_REMOVED: ${input.urls.length - uniqueUrls.length} duplicate URL(s) in the batch were removed; each unique URL is traversed once and reports one slot (requested counts unique URLs).`,
    );
  }
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
    urls: uniqueUrls,
    waitUntil: input.waitUntil,
    siteProfile: input.siteProfile,
    expectedPostalCode,
    compact: input.compact,
  };

  // §18 promotion rule: 'auto' answers inline only for a batch that fits
  // this tool's own catalog deadline at the catalog's per-item charge
  // (MAX_INLINE_BATCH_ITEMS, derived in packages/protocol/src/catalog.ts).
  // Judged on UNIQUE URLs — the work actually performed.
  const resolvedMode =
    input.mode === 'auto' ? (uniqueUrls.length <= MAX_INLINE_BATCH_ITEMS ? 'inline' : 'job') : input.mode;

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
          `BATCH_DEADLINE_REACHED: ${results.length} of ${uniqueUrls.length} URLs were traversed before the call's deadline; re-issue the remainder, or use mode "job".`,
        );
      }
      return {
        result: inlineProgress(status, uniqueUrls.length, input.compact, results, warnings),
        pageRevision: results.at(-1)?.pageRevision ?? null,
        artifacts: [],
      };
    });
  }

  const store = resolveJobStore(host);
  const job: BatchJob = store.create(
    envelope.browserSessionHandle,
    uniqueUrls.length,
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
