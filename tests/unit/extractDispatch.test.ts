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
