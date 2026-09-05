/**
 * browser_extract page-kind dispatch (FR-15). The Fluxology scheduled runs
 * traverse eBay search results and seller stores and Kijiji radius search
 * pages, so extract must return structured candidate records for those page
 * kinds instead of refusing everything that is not a canonical item page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BrowserSessionRuntime } from '@browser-bridge/browser-core';
import { ExtractOutput, WIRE_PROTOCOL_VERSION, type CommandEnvelope } from '@browser-bridge/protocol';
import { mergeSiteProfiles } from '@browser-bridge/policy';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import {
  createLogger,
  executeCommand,
  type ExecutorHost,
  type SessionHost,
} from '@browser-bridge/windows-agent';
// Relative import; see kijijiExtract.test.ts for the tests/package.json rationale.
import { kijijiSiteProfile } from '../../packages/site-kijiji/src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), 'utf8');
}

function stubSession(pageUrl: string, html: string): BrowserSessionRuntime {
  return {
    policy: { profile: mergeSiteProfiles([ebaySiteProfile, kijijiSiteProfile]) },
    enqueue: (fn: () => Promise<unknown>) => fn(),
    getTab: () => ({
      page: { url: () => pageUrl, content: async () => html },
      revision: 7,
    }),
  } as unknown as BrowserSessionRuntime;
}

function hostFor(session: BrowserSessionRuntime): ExecutorHost {
  const sessions: SessionHost = {
    open: () => Promise.reject(new Error('session_open is not exercised here')),
    resolve: () => session,
    listActive: () => [session],
    isDegraded: false,
  };
  return { sessions, logger: createLogger('fatal', 'extract-dispatch-test'), expectedPostalCode: 'M6H 2W9' };
}

function extractEnvelope(siteProfile: string): CommandEnvelope {
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    type: 'command',
    requestId: 'req-extract-1',
    deviceId: 'dev-1',
    browserSessionHandle: 'sess-1',
    tabId: 'tab-1',
    command: 'extract',
    arguments: { siteProfile },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: 'idem-extract-1',
    policyClass: 'read',
    traceparent: null,
  };
}

async function runExtract(pageUrl: string, html: string, siteProfile: string) {
  const session = stubSession(pageUrl, html);
  return executeCommand(hostFor(session), extractEnvelope(siteProfile));
}

describe('browser_extract dispatches by page kind instead of refusing', () => {
  it('eBay search results return an ordered candidate list', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/sch/i.html?_nkw=lego+minifig+lot&_sop=10',
      fixture('ebay', 'search-results.html'),
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.siteProfile).toBe('ebay.ca.v1');
    const record = parsed.record as {
      pageKind: string;
      candidateCount: number;
      candidates: { itemId: string; url: string }[];
    };
    expect(record.pageKind).toBe('search');
    expect(record.candidateCount).toBeGreaterThan(0);
    expect(record.candidates[0]!.itemId).toMatch(/^\d+$/);
    expect(record.candidates[0]!.url).toContain('/itm/');
    expect(parsed.warnings).toEqual([]);
  });

  it('eBay seller store pages return candidates for seller drill-downs', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/str/tweedsidesales',
      fixture('ebay', 'seller-store.html'),
      'ebay.ca.v1',
    );
    const record = ExtractOutput.parse(outcome.result).record as { pageKind: string; candidateCount: number };
    expect(record.pageKind).toBe('store');
    expect(record.candidateCount).toBeGreaterThan(0);
  });

  // 2026-09-02 deals fire: three /usr/<loginId> seller pages came back as
  // all-null item records (see compact.test.ts for the projection half).
  // The classifier half: /usr/ is a store page, and a store page names
  // itself — the rendered <title> rides on the record so an unavailable
  // profile (eBay's error template, empty title) can be told from a live
  // store with no active listings without a second browser_snapshot call.
  it('eBay /usr/ seller-profile pages are store pages carrying the rendered title', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/usr/brickdeals_toronto',
      fixture('ebay', 'seller-store.html'),
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; pageTitle: string; candidateCount: number };
    expect(record.pageKind).toBe('store');
    expect(record.pageTitle).toBe('brickdeals_toronto on eBay');
    expect(record.candidateCount).toBeGreaterThan(0);
    expect(parsed.warnings.some((warning) => warning.startsWith('UNCLASSIFIED_PAGE'))).toBe(false);
  });

  it('an empty eBay store page says the title was empty instead of a generic candidate miss', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/usr/audi2005store',
      '<html><head><title></title></head><body><img alt="Attention"></body></html>',
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; pageTitle: string; candidateCount: number };
    expect(record.pageKind).toBe('store');
    expect(record.pageTitle).toBe('');
    expect(record.candidateCount).toBe(0);
    const empty = parsed.warnings.find((warning) => warning.startsWith('STORE_NO_CANDIDATES'));
    expect(empty).toBeDefined();
    expect(empty).toContain('empty <title>');
    expect(parsed.warnings.some((warning) => warning.startsWith('NO_LISTING_CANDIDATES'))).toBe(false);
  });

  // Track W / Track O: the deals routine walks the operator's own watch list
  // and offers page in the signed-in research profile. Both are candidate
  // pages with extra per-row fields; both must go through the same
  // compaction the search pages use so search.include/fields/limit apply.
  it('the My eBay watch list returns pageKind watchlist with countdowns, offers and pagination', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/mye/myebay/watchlist',
      fixture('ebay', 'watchlist-page.html'),
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as {
      pageKind: string;
      pageTitle: string;
      signedIn: boolean | null;
      totalResults: number | null;
      totalCountSource: string | null;
      candidateCount: number;
      hasNextPage: boolean;
      nextPageUrl: string | null;
      candidates: Array<Record<string, unknown>>;
    };
    expect(record.pageKind).toBe('watchlist');
    expect(record.pageTitle).toBe('Watch list | My eBay');
    expect(record.signedIn).toBe(true);
    expect(record.totalResults).toBe(312);
    expect(record.totalCountSource).toBe('All (312)');
    expect(record.candidateCount).toBe(5);
    expect(record.hasNextPage).toBe(true);
    expect(record.nextPageUrl).toBe('https://www.ebay.ca/mye/myebay/watchlist?page=2');
    // The watch-list default projection carries the row fields the walk reads.
    const withOffer = record.candidates.find((row) => row.itemId === '127905836341')!;
    expect(withOffer.url).toBe('https://www.ebay.com/itm/127905836341');
    // The offer sentence stops at the card's separator; the expiry is its own field on the offers page.
    expect(withOffer.sellerOffer).toEqual({ text: 'Seller sent you an offer: US $165.00', price: { value: 165, currency: 'USD' } });
    // Price plus a Best Offer control, no countdown: the card states no
    // status (2026-09-04 overflow render), so the walk reads none from it.
    expect(withOffer.watchlistStatus).toBe('unknown');
    const auction = record.candidates.find((row) => row.itemId === '198589141532')!;
    expect(auction.timeLeftText).toBe('1d 04h 12m left');
    expect(typeof auction.endsAt).toBe('string');
    expect(auction.seller).toBe('netgear_liquidators');
    expect(parsed.warnings.some((warning) => warning.startsWith('UNCLASSIFIED_PAGE'))).toBe(false);
  });

  it('a watch-list sign-in wall is SIGN_IN_REQUIRED, not an empty list', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/mye/myebay/watchlist',
      fixture('ebay', 'watchlist-signin.html'),
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; signedIn: boolean | null; candidateCount: number };
    expect(record.pageKind).toBe('watchlist');
    expect(record.signedIn).toBe(false);
    expect(record.candidateCount).toBe(0);
    expect(parsed.warnings.some((warning) => warning.startsWith('SIGN_IN_REQUIRED'))).toBe(true);
    expect(parsed.warnings.some((warning) => warning.startsWith('NO_LISTING_CANDIDATES'))).toBe(false);
  });

  it('the bids/offers page returns pageKind offers with one classified row per offer', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/mye/myebay/bidsoffers',
      fixture('ebay', 'offers-page.html'),
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; signedIn: boolean | null; candidateCount: number; candidates: Array<Record<string, unknown>> };
    expect(record.pageKind).toBe('offers');
    expect(record.signedIn).toBe(true);
    expect(record.candidateCount).toBe(3);
    expect(record.candidates.map((row) => [row.direction, row.offerStatus])).toEqual([
      ['from_seller', 'open'],
      ['from_you', 'declined'],
      ['from_seller', 'expired'],
    ]);
    expect(record.candidates[0]!.offerPrice).toEqual({ value: 165, currency: 'USD' });
    expect(record.candidates[0]!.expiresText).toBe('Expires in 1d 22h');
  });

  it('an unclassified eBay page still extracts, scanning it for /itm/ links', async () => {
    // The eBay homepage classifies as 'other'. It is not a refusal: the same
    // scan the search pages use runs, and it finds whatever item links exist.
    const outcome = await runExtract('https://www.ebay.ca/', fixture('ebay', 'search-results.html'), 'ebay.ca.v1');
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; candidateCount: number };
    expect(record.pageKind).toBe('other');
    expect(record.candidateCount).toBeGreaterThan(0);
    expect(parsed.warnings.some((warning) => warning.startsWith('UNCLASSIFIED_PAGE'))).toBe(true);
  });

  it('an unclassified eBay page with no listings reports empty rather than failing', async () => {
    const outcome = await runExtract('https://www.ebay.ca/', '<html><body></body></html>', 'ebay.ca.v1');
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; candidateCount: number };
    expect(record.pageKind).toBe('other');
    expect(record.candidateCount).toBe(0);
    // Both warnings matter: one says the page kind was unknown, the other
    // says the scan came back empty. Neither alone distinguishes "no
    // listings here" from "wrong page".
    expect(parsed.warnings.some((warning) => warning.startsWith('UNCLASSIFIED_PAGE'))).toBe(true);
    expect(parsed.warnings.some((warning) => warning.startsWith('NO_LISTING_CANDIDATES'))).toBe(true);
  });

  // 2026-09-03 wardrobe Lane B fire (site-zazzle+extractor_defect+zazzle-
  // listing-grids-render-product-free-pdps-unaffected): /c/hats committed
  // with the real category title, and the shell sentence with NO product
  // grid, while product pages on the same host extracted normally in the
  // same session. The warning told the run to go drive the search box —
  // the route that had already produced the same shell on the Lane A fire.
  it('a curated /c/ category page rendering the no-results shell is named as a grid-free category page, not a search miss', async () => {
    const outcome = await runExtract(
      'https://www.zazzle.ca/c/hats',
      '<html><head><title>Hats &amp; Caps | Zazzle CA</title></head><body><main><h1>Hats &amp; Caps</h1><p>Sorry, your search did not match any products.</p></main><aside class="RecentlyViewedRail"><a href="https://www.zazzle.ca/custom_logo_hat-256140446817787648">Recently viewed</a></aside></body></html>',
      'zazzle.com.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; candidateCount: number; noResultsShell: boolean };
    expect(record.pageKind).toBe('search');
    expect(record.candidateCount).toBe(0);
    expect(record.noResultsShell).toBe(true);
    const category = parsed.warnings.find((warning) => warning.startsWith('CATEGORY_EMPTY_SHELL'));
    expect(category).toBeDefined();
    // A category page cannot legitimately have zero products: the remedy
    // must not send the run back to the search box, and must say to record
    // the grid absence once as a coverage boundary.
    expect(category).not.toMatch(/drive the search box/);
    expect(category).toMatch(/once/);
    expect(parsed.warnings.some((warning) => warning.startsWith('SEARCH_EMPTY_SHELL'))).toBe(false);
  });

  it('a /s/ search shell no longer prescribes the search-box route as if it were a different one', async () => {
    const outcome = await runExtract(
      'https://www.zazzle.ca/s/logo+polo+shirt',
      '<html><head><title>Logo Polo T-Shirts | Zazzle CA</title></head><body><main><p>Sorry, your search did not match any products.</p></main></body></html>',
      'zazzle.com.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const shell = parsed.warnings.find((warning) => warning.startsWith('SEARCH_EMPTY_SHELL'));
    expect(shell).toBeDefined();
    // Both routes dead-ended identically on 2026-09-03: the remedy has to
    // say what to do when the search box lands on the same shell.
    expect(shell).toMatch(/same shell/);
  });

  // wardrobe-vendors.v1 ships no extractor. Before this branch a vendor
  // page fell through to the eBay listing extractor and came back as an
  // all-null eBay record — plausible-looking junk. Now it says so.
  it('a wardrobe-vendor page reports that no extractor exists instead of an eBay-shaped null record', async () => {
    const outcome = await runExtract(
      'https://www.vistaprint.ca/clothing-bags/polos/embroidered-polo-shirts',
      '<html><head><title>Embroidered Polo Shirts | Vistaprint</title></head><body><a href="/clothing-bags/polos/p1">Polo</a></body></html>',
      'zazzle.com.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.siteProfile).toBe('wardrobe-vendors.v1');
    const record = parsed.record as { pageKind: string; pageTitle: string; pageUrl: string };
    expect(record.pageKind).toBe('other');
    expect(record.pageTitle).toBe('Embroidered Polo Shirts | Vistaprint');
    expect(record.pageUrl).toContain('vistaprint.ca');
    expect(parsed.warnings.some((warning) => warning.startsWith('NO_EXTRACTOR_FOR_HOST'))).toBe(true);
    expect('itemId' in record).toBe(false);
  });

  it('an unclassified Kijiji page still extracts rather than refusing', async () => {
    const outcome = await runExtract(
      'https://www.kijiji.ca/',
      fixture('kijiji', 'search-results.html'),
      'kijiji.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; candidateCount: number };
    expect(record.pageKind).toBe('other');
    expect(record.candidateCount).toBeGreaterThan(0);
    expect(parsed.warnings.some((warning) => warning.startsWith('UNCLASSIFIED_PAGE'))).toBe(true);
  });

  it('Kijiji search results return candidates plus next-page pagination', async () => {
    const outcome = await runExtract(
      'https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273?radius=45&address=M6H+2W9',
      fixture('kijiji', 'search-results.html'),
      'kijiji.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.siteProfile).toBe('kijiji.ca.v1');
    const record = parsed.record as {
      pageKind: string;
      candidateCount: number;
      candidates: { adId: string }[];
      hasNextPage: boolean;
      nextPageUrl: string | null;
    };
    expect(record.pageKind).toBe('search');
    expect(record.candidateCount).toBeGreaterThan(0);
    expect(record.candidates[0]!.adId).toMatch(/^\d+$/);
    // 2026-09-02 (site-kijiji+extractor_defect+radius-param-ineffective-
    // l1700273): kijiji.ca ignores radius= and address= outright — the same
    // params without a region id returned Edmonton and Winnipeg ads for a
    // 45 km radius around M6H 2W9. A search URL still carrying them gets a
    // warning so no run reports a radius the site never applied.
    const inert = parsed.warnings.find((warning) => warning.startsWith('RADIUS_PARAM_INERT'));
    expect(inert).toBeDefined();
    expect(inert).toContain('radius=45');
    expect(inert).toContain('l1700273');
    expect(record.hasNextPage).toBe(true);
    expect(record.nextPageUrl).toContain('page-2');
  });

  // 2026-09-02 deals fire (site-kijiji+coverage_gap+kijiji-no-seller-
  // inventory-surface): a Kijiji seller's other ads were unreachable except
  // by keyword collision. The ad record now carries the poster's
  // /o-profile/<id>/<page> URL, and that page dispatches as a candidate
  // page: the same anchor-href ad scan the search pages run, under its own
  // page kind, with the caveat that no live /o-profile/ page is captured.
  it('Kijiji seller (/o-profile/) pages return candidates under pageKind seller', async () => {
    const outcome = await runExtract(
      'https://www.kijiji.ca/o-profile/1008009261/1',
      fixture('kijiji', 'search-results.html'),
      'kijiji.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; candidateCount: number; candidates: { adId: string }[] };
    expect(record.pageKind).toBe('seller');
    expect(record.candidateCount).toBeGreaterThan(0);
    expect(record.candidates[0]!.adId).toMatch(/^\d+$/);
    expect(parsed.warnings.some((warning) => warning.startsWith('UNCLASSIFIED_PAGE'))).toBe(false);
    const unverified = parsed.warnings.find((warning) => warning.startsWith('SELLER_PAGE_UNVERIFIED'));
    expect(unverified).toBeDefined();
    expect(unverified).toContain('browser_snapshot');
  });

  // 2026-09-04 20:00Z deals fire (site-kijiji+extractor_defect+seller-
  // profile-page-renders-no-listings-at-domcontentloaded): the first live
  // read of /o-profile/1046282996/1 redirected to /o-profile/1046282996/
  // listings/1 and returned candidateCount 0 — the bounded snapshot showed
  // 41 nodes of site chrome and no ad link, because the listings container
  // is client-rendered and was not in the DOM when the page was captured
  // at domcontentloaded. Ground truth: the three ad records that led there
  // state sellerListingCount 26. The seller page kind now waits, bounded,
  // for the first ad link before it reads the page, and says it did.
  describe('a Kijiji seller page whose listings render after domcontentloaded', () => {
    const chromeOnly = `<html><head><title>Kijiji</title></head><body><header><input placeholder="Search"><button>Search</button></header>
      <main id="listings"></main><footer><a href="/about">About</a></footer></body></html>`;
    const hydrated = `<html><head><title>Kijiji</title></head><body><header><input placeholder="Search"><button>Search</button></header>
      <main id="listings"><ul>
        <li><a href="/v-other/city-of-toronto/apc-42u-netshelter-rack-cabinet/1741647474">APC 42U NetShelter rack cabinet</a><span>$300.00</span></li>
        <li><a href="/v-other/city-of-toronto/ibm-42u-server-rack/1741647620">IBM 42U server rack</a><span>$300.00</span></li>
        <li><a href="/v-other/city-of-toronto/36u-rack-cabinet/1741647824">36U rack cabinet</a><span>$220.00</span></li>
      </ul></main><footer><a href="/about">About</a></footer></body></html>`;

    function hydratingSession(pageUrl: string, waitOutcome: 'appears' | 'never'): { session: BrowserSessionRuntime; waits: string[] } {
      const waits: string[] = [];
      let html = chromeOnly;
      const page = {
        url: () => pageUrl,
        content: async () => html,
        waitForSelector: async (selector: string) => {
          waits.push(selector);
          if (waitOutcome === 'never') throw new Error('Timeout 4000ms exceeded');
          html = hydrated;
          return {};
        },
      };
      const tab = { page, revision: 7 };
      const session = {
        policy: { profile: mergeSiteProfiles([ebaySiteProfile, kijijiSiteProfile]) },
        enqueue: (fn: () => Promise<unknown>) => fn(),
        getTab: () => tab,
      } as unknown as BrowserSessionRuntime;
      return { session, waits };
    }

    it('waits for the first ad link, re-reads the page and reports the wait', async () => {
      const { session, waits } = hydratingSession('https://www.kijiji.ca/o-profile/1046282996/listings/1', 'appears');
      const outcome = await executeCommand(hostFor(session), extractEnvelope('kijiji.ca.v1'));
      const parsed = ExtractOutput.parse(outcome.result);
      const record = parsed.record as { pageKind: string; candidateCount: number; candidates: { adId: string }[]; nextPageUrl: string | null };
      expect(record.pageKind).toBe('seller');
      expect(record.candidateCount).toBe(3);
      expect(record.candidates.map((row) => row.adId)).toEqual(['1741647474', '1741647620', '1741647824']);
      expect(waits).toEqual(['a[href*="/v-"]']);
      const waited = parsed.warnings.find((warning) => warning.startsWith('LISTINGS_HYDRATED_AFTER_WAIT'));
      expect(waited).toBeDefined();
      expect(waited).toContain('domcontentloaded');
      expect(parsed.warnings.some((warning) => warning.startsWith('NO_LISTING_CANDIDATES'))).toBe(false);
    });

    it('says when the wait expired with no ad link, and still reports the empty page', async () => {
      const { session } = hydratingSession('https://www.kijiji.ca/o-profile/1046282996/listings/1', 'never');
      const outcome = await executeCommand(hostFor(session), extractEnvelope('kijiji.ca.v1'));
      const parsed = ExtractOutput.parse(outcome.result);
      const record = parsed.record as { candidateCount: number };
      expect(record.candidateCount).toBe(0);
      const expired = parsed.warnings.find((warning) => warning.startsWith('LISTINGS_NOT_HYDRATED'));
      expect(expired).toBeDefined();
      expect(expired).toContain('browser_snapshot');
      expect(parsed.warnings.some((warning) => warning.startsWith('NO_LISTING_CANDIDATES'))).toBe(true);
    });

    it('does not wait on a search page that rendered its cards', async () => {
      const { session, waits } = hydratingSession('https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273', 'appears');
      (session.getTab('tab-1') as unknown as { page: { content: () => Promise<string> } }).page.content = async () =>
        fixture('kijiji', 'search-results.html');
      await executeCommand(hostFor(session), extractEnvelope('kijiji.ca.v1'));
      expect(waits).toEqual([]);
    });
  });

  it('Kijiji ad (VIP) pages return the full extraction record', async () => {
    const outcome = await runExtract(
      'https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-friends-bulk-lot-5-lbs/1712345678',
      fixture('kijiji', 'vip-jsonld.html'),
      'kijiji.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.siteProfile).toBe('kijiji.ca.v1');
    const record = parsed.record as { adId: { value: string } | null; listingStatus: string };
    expect(record.adId?.value).toBe('1712345678');
    expect(record.listingStatus).toBe('active');
  });

  it('a declared-profile mismatch downgrades to a warning, never a refusal', async () => {
    const outcome = await runExtract(
      'https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273?radius=45',
      fixture('kijiji', 'search-results.html'),
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.siteProfile).toBe('kijiji.ca.v1');
    expect(parsed.warnings.some((warning) => warning.startsWith('DECLARED_SITE_PROFILE_MISMATCH'))).toBe(true);
  });
});

// 2026-09-04 deals fire: /str/lapennaco rendered 50 cards with title and
// URL but every snippetPrice null (store-page-snippetprice-null-on-every-
// row). The extractor now falls back to the card text; the page-level
// warning says how many prices came from text so a run can see that the
// hint is a text read, not a priced element.
describe('store cards priced from text are named at page level', () => {
  it('SNIPPET_PRICE_FROM_CARD_TEXT counts the cards whose price came from text', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/str/lapennaco?_sop=10&_ipg=240',
      `<html><head><title>LaPenna Co | eBay Stores</title></head><body><div class="str-search-results">
         <div class="str-grid-item"><a href="https://www.ebay.ca/itm/800106302072"><h3>Cisco C9130AXE-A</h3></a><div><span>C $59.99</span></div><div><span>+C $12.00 shipping</span></div></div>
         <div class="str-grid-item"><a href="https://www.ebay.ca/itm/800348101076"><h3>Cisco bracket</h3></a><div><span>C $24.50</span></div></div>
         <div class="str-grid-item"><a href="https://www.ebay.ca/itm/555666777888"><h3>Priced element</h3></a><span class="s-card__price">C $19.99</span></div>
       </div></body></html>`,
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as {
      pageKind: string;
      candidates: { itemId: string; snippetPrice: { value: number } | null; sellingFormat: string }[];
    };
    expect(record.pageKind).toBe('store');
    expect(record.candidates.map((row) => row.snippetPrice?.value)).toEqual([59.99, 24.5, 19.99]);
    expect(record.candidates.map((row) => row.sellingFormat)).toEqual(['fixed_price', 'fixed_price', 'fixed_price']);
    const fromText = parsed.warnings.find((warning) => warning.startsWith('SNIPPET_PRICE_FROM_CARD_TEXT'));
    expect(fromText).toBeDefined();
    expect(fromText).toContain('2 of 3');
  });

  it('is silent when every price came from a priced element', async () => {
    const outcome = await runExtract('https://www.ebay.ca/str/tweedsidesales', fixture('ebay', 'seller-store.html'), 'ebay.ca.v1');
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.warnings.some((warning) => warning.startsWith('SNIPPET_PRICE_FROM_CARD_TEXT'))).toBe(false);
  });
});

// 2026-09-02 deals fire (b-keyword-path-silently-drops-keyword): the record
// carries the keyword the page applied and warns when it is not the one the
// URL asked for.
describe('kijiji search records carry searchTerm and KEYWORD_NOT_APPLIED', () => {
  it('a keyword URL whose page applied another keyword is warned about, and the record says which', async () => {
    const outcome = await runExtract(
      'https://www.kijiji.ca/b-gta-greater-toronto-area/lego/k0l1700273',
      `<html><head><title>77 ads for gta greater toronto area in All Categories in City of Toronto | Kijiji Marketplaces</title></head>
       <body><h1>"gta greater toronto area" in All Categories in City of Toronto</h1>
       <ul><li><a href="/v-plumbers/city-of-toronto/professional-licensed-plumber-in-gta/1742364312">Professional Licensed Plumber in GTA</a></li></ul>
       </body></html>`,
      'kijiji.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    const record = parsed.record as { pageKind: string; searchTerm: string | null };
    expect(record.pageKind).toBe('search');
    expect(record.searchTerm).toBe('gta greater toronto area');
    expect(parsed.warnings.some((warning) => warning.startsWith('KEYWORD_NOT_APPLIED'))).toBe(true);
  });
});
