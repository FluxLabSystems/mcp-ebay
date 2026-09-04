import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
// site-kijiji is imported by relative path rather than a workspace alias:
// tests/package.json is not modified by this change, so the package is not
// linked into tests/node_modules; tsc and vitest both resolve the
// TypeScript source directly through this path.
import {
  buildKeywordSearchUrl,
  buildSearchUrl,
  classifyKijijiPage,
  extractKijijiListing,
  extractSearchResults,
  isKijijiListingPage,
  KijijiExtractionRecordSchema,
  kijijiKeywordWarnings,
  kijijiSearchUrlWarnings,
} from '../../packages/site-kijiji/src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kijiji');

function loadFixture(name: string): Document {
  const html = readFileSync(join(FIXTURES, name), 'utf8');
  return parseHTML(html).document as unknown as Document;
}

describe('kijiji.ca.v1 VIP extraction', () => {
  it('extracts the active ad with JSON-LD provenance winning over DOM candidates', () => {
    const document = loadFixture('vip-jsonld.html');
    const { record, warnings } = extractKijijiListing(
      document,
      'https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-friends-bulk-lot-5-lbs/1712345678?utm_campaign=social',
      { pageRevision: 2 },
    );

    expect(KijijiExtractionRecordSchema.parse(record)).toBeTruthy();
    expect(record.adId).toMatchObject({ value: '1712345678', confidence: 1.0 });
    expect(record.canonicalUrl).toMatchObject({
      value: 'https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-friends-bulk-lot-5-lbs/1712345678',
      source: 'computed',
    });
    expect(record.title).toMatchObject({ value: 'LEGO Friends Bulk Lot 5 lbs', source: 'jsonld' });
    // The DOM shows $40.00; JSON-LD's 35.00 must win with jsonld provenance.
    expect(record.price).toMatchObject({ kind: 'amount', value: 35, currency: 'CAD', source: 'jsonld' });
    expect(record.location).toMatchObject({ text: 'Toronto, ON M6H 2W9', source: 'dom' });
    expect(record.postedAt).toBe('2026-08-15T09:30:00.000Z');
    expect(record.postedText).toBe('August 15, 2026');
    expect(record.sellerName).toMatchObject({ value: 'brickmover_to', source: 'jsonld' });
    expect(record.sellerType).toBe('owner');
    expect(record.attributes).toContainEqual({ label: 'For Sale By', value: 'Owner' });
    expect(record.description).toMatchObject({ source: 'jsonld' });
    expect(record.imageCount).toBe(2);
    expect(record.listingStatus).toBe('active');
    expect(record.pageRevision).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('falls back to DOM selectors with dom provenance and confidence', () => {
    const document = loadFixture('vip-dom-only.html');
    const { record, warnings } = extractKijijiListing(
      document,
      'https://www.kijiji.ca/v-buy-sell/north-york/lego-technic-bins/2109876543?hidepostedad=true',
    );

    expect(KijijiExtractionRecordSchema.parse(record)).toBeTruthy();
    expect(record.adId).toMatchObject({ value: '2109876543', source: 'dom' });
    expect(record.canonicalUrl?.value).toBe('https://www.kijiji.ca/v-buy-sell/north-york/lego-technic-bins/2109876543');
    expect(record.title).toMatchObject({ value: 'LEGO Technic Bins - Huge Cleanout', source: 'dom', confidence: 0.99 });
    expect(record.price).toMatchObject({ kind: 'contact', value: null, source: 'dom', confidence: 0.99 });
    expect(record.location).toMatchObject({ text: 'North York, ON', source: 'dom' });
    expect(record.postedAt).toBeNull();
    expect(record.postedText).toBe('Posted less than an hour ago');
    expect(record.sellerName).toMatchObject({ value: 'North York Brick Depot', source: 'dom' });
    expect(record.sellerType).toBe('dealer');
    expect(record.attributes).toContainEqual({ label: 'Condition', value: 'Used - Fair' });
    expect(record.description?.source).toBe('dom');
    expect(record.description?.value).toHaveLength(500);
    expect(record.imageCount).toBe(3);
    expect(record.listingStatus).toBe('active');
    expect(warnings.some((warning) => warning.includes('postedAt'))).toBe(true);
  });

  it('detects deleted and expired ads from marker text', () => {
    expect(
      extractKijijiListing(loadFixture('vip-deleted.html'), 'https://www.kijiji.ca/v-buy-sell/x/1111111111').record
        .listingStatus,
    ).toBe('deleted');
    expect(
      extractKijijiListing(loadFixture('vip-expired.html'), 'https://www.kijiji.ca/v-buy-sell/x/2222222222').record
        .listingStatus,
    ).toBe('expired');
  });
});

describe('kijiji search traversal', () => {
  it('extracts deduplicated result cards and next-page detection', () => {
    const document = loadFixture('search-results.html');
    const page = extractSearchResults(
      document,
      'https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273?radius=45&address=M6H+2W9',
    );

    expect(page.results).toHaveLength(2);
    expect(page.results[0]).toMatchObject({
      adId: '1712345678',
      url: 'https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-friends-bulk-lot-5-lbs/1712345678',
      title: 'LEGO Friends Bulk Lot 5 lbs',
      priceText: '$35.00',
      locationText: 'City of Toronto',
      postedText: 'Yesterday',
    });
    expect(page.results[0]?.price).toMatchObject({ kind: 'amount', value: 35, currency: 'CAD' });
    expect(page.results[1]).toMatchObject({ adId: '2109876543' });
    expect(page.results[1]?.price).toMatchObject({ kind: 'swap', value: null });
    expect(page.hasNextPage).toBe(true);
    expect(page.nextPageUrl).toBe('https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/page-2/c10l1700273?radius=45');
  });

  // 2026-09-02 deals fire (site-kijiji+extractor_defect+radius-param-
  // ineffective-l1700273), isolated on the corrected URL form: radius=45.0
  // and radius=65.0 returned byte-identical sets (totalResults=3915) under
  // k0l1700273, and radius=45.0&address=M6H 2W9 with NO region id returned
  // 31,536 ads led by Laval, Edmonton and Winnipeg. The site ignores both
  // parameters; scope comes only from the l<regionId> path segment.
  it('never emits radius= or address=, which kijiji.ca ignores', () => {
    expect(
      buildSearchUrl({
        query: 'lego bulk lot',
        categoryPath: 'b-buy-sell/city-of-toronto/c10l1700273',
        sortByNewest: true,
      }),
    ).toBe('https://www.kijiji.ca/b-buy-sell/city-of-toronto/c10l1700273?q=lego+bulk+lot&sort=dateDesc');
    expect(buildSearchUrl({ query: 'lego bulk lot', categoryPath: '/b-buy-sell/canada/', sortByNewest: false })).toBe(
      'https://www.kijiji.ca/b-buy-sell/canada?q=lego+bulk+lot',
    );
    expect(buildSearchUrl({ query: '', categoryPath: '', sortByNewest: false })).toBe(
      'https://www.kijiji.ca/b-buy-sell/canada',
    );
  });

  it('builds the keyword-in-path search form the 2026-09-02 fire saw return 3,915 LEGO ads', () => {
    expect(
      buildKeywordSearchUrl({
        keyword: 'lego',
        locationSlug: 'gta-greater-toronto-area',
        regionId: '1700273',
        sortByNewest: true,
      }),
    ).toBe('https://www.kijiji.ca/b-gta-greater-toronto-area/lego/k0l1700273?sort=dateDesc');
    // Multi-word keywords join with '-', like Kijiji's own slugs; the
    // region id is digits only and the slug never carries slashes.
    expect(
      buildKeywordSearchUrl({
        keyword: ' Lego  Bulk Lot ',
        locationSlug: '/city-of-toronto/',
        regionId: 'l1700273',
        sortByNewest: false,
      }),
    ).toBe('https://www.kijiji.ca/b-city-of-toronto/lego-bulk-lot/k0l1700273');
  });

  it('warns about a search URL that still carries the inert radius/address parameters', () => {
    const warnings = kijijiSearchUrlWarnings(
      'https://www.kijiji.ca/b-gta-greater-toronto-area/lego/k0l1700273?radius=45.0&address=M6H%202W9&sort=dateDesc',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^RADIUS_PARAM_INERT: /);
    expect(warnings[0]).toContain('radius=45.0');
    expect(warnings[0]).toContain('address=');
    expect(warnings[0]).toContain('l1700273');
    expect(kijijiSearchUrlWarnings('https://www.kijiji.ca/b-gta-greater-toronto-area/lego/k0l1700273?sort=dateDesc')).toEqual([]);
    expect(kijijiSearchUrlWarnings('not a url')).toEqual([]);
  });
});

describe('kijiji page classification', () => {
  it('recognizes VIP pages on the kijiji.ca host family only', () => {
    expect(isKijijiListingPage('https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-lot/1712345678')).toBe(true);
    expect(isKijijiListingPage('https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-lot/1712345678?utm=1')).toBe(true);
    expect(isKijijiListingPage('https://kijiji.ca/v-view-details.html?adId=1712345678')).toBe(true);
    expect(isKijijiListingPage('https://www.kijiji.ca/b-buy-sell/city-of-toronto/c10l1700273')).toBe(false);
    expect(isKijijiListingPage('https://www.ebay.ca/itm/123456789012')).toBe(false);
    expect(isKijijiListingPage('https://www.kijiji.ca/')).toBe(false);
    expect(isKijijiListingPage('not a url')).toBe(false);
  });

  it('classifies listing, search, and other page kinds', () => {
    expect(classifyKijijiPage('https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-lot/1712345678')).toBe('listing');
    expect(classifyKijijiPage('https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273?radius=45')).toBe(
      'search',
    );
    expect(classifyKijijiPage('https://www.kijiji.ca/')).toBe('other');
    expect(classifyKijijiPage('not a url')).toBe('other');
  });
});

// Four defects a live Kijiji run surfaced on 2026-08-26. Each fixture fails
// against the extractor as it stood before this suite was added.
describe('defects found on the first live Kijiji run', () => {
  const LIVE_AD_URL = 'https://www.kijiji.ca/v-toys-games/city-of-toronto/lego-bulk-lot/1712345678';

  function liveAd() {
    return extractKijijiListing(loadFixture('live-ad-with-i18n-bundle.html'), LIVE_AD_URL, { pageRevision: 1 });
  }

  it('does not read a banner string out of the inline i18n bundle', () => {
    // body.textContent includes <script>, and Kijiji ships every banner
    // string it can render inline. The page displays none of them.
    expect(liveAd().record.listingStatus).toBe('active');
  });

  it('takes the seller username, not the avatar monogram', () => {
    // The profile anchor wraps a "J" avatar; the username is on its title.
    expect(liveAd().record.sellerName?.value).toBe('junior');
  });

  it('resolves location from the postal code the sidebar renders', () => {
    const { record, warnings } = liveAd();
    expect(record.location?.text).toContain('M6H 2W9');
    expect(warnings.some((warning) => warning.startsWith('location resolved from a postal code'))).toBe(true);
  });

  it('still validates against the canonical record schema', () => {
    expect(KijijiExtractionRecordSchema.safeParse(liveAd().record).success).toBe(true);
  });

  it('reports more pages from the stated count when no next link is present', () => {
    const page = extractSearchResults(
      loadFixture('search-results-count-only.html'),
      'https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273',
    );
    // 73 results, 40 shown: there is unambiguously a page two, whether or
    // not a "next" anchor can be found.
    expect(page.totalResults).toBe(73);
    expect(page.hasNextPage).toBe(true);
    // Best-effort link, synthesised from the URL shape.
    expect(page.nextPageUrl).toContain('page-2');
  });

  it('does not claim a next page when the count says this is all of them', () => {
    const document = loadFixture('search-results-count-only.html');
    const header = document.querySelector('[data-testid="srp-results-count"] span');
    if (header) header.textContent = '1 - 2 of 2 Ads';
    const page = extractSearchResults(document, 'https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273');
    expect(page.totalResults).toBe(2);
    expect(page.hasNextPage).toBe(false);
    expect(page.nextPageUrl).toBeNull();
  });
});

// G0 (2026-09-03 office fire): on VIP pages a broad location selector picked up
// a third-party neighbourhood marketing blurb ("About The Annex Explore the
// area … This information is provided by a third party data source …") in the
// location field. The blurb must be rejected so the og:locality fallback runs.
describe('VIP location rejects the neighbourhood blurb (G0)', () => {
  it('falls back to og:locality instead of the third-party area blurb', () => {
    const document = parseHTML(
      `<html><head>
         <meta property="og:locality" content="Toronto (GTA)">
       </head><body>
         <h1>Office space Dupont and Spadina</h1>
         <div class="locationContainer">About The Annex Explore the area The Annex has a character that caters to a fairly diverse group of people. This information is provided by a third party data source. Kijiji is not responsible for the accuracy of this information.</div>
       </body></html>`,
    ).document as unknown as Document;
    const { record, warnings } = extractKijijiListing(
      document,
      'https://www.kijiji.ca/v-commercial-office-space/city-of-toronto/office-space/1742919641',
    );
    expect(record.location?.text).toBe('Toronto (GTA)');
    expect(record.location?.source).toBe('meta');
    expect(warnings.some((w) => w.includes('og:locality'))).toBe(true);
  });
});

// 2026-09-02 deals fire (site-kijiji+extractor_defect+b-keyword-path-silently-
// drops-keyword): /b-lego/gta-greater-toronto-area/k0l1700273 came back as an
// ordinary search page — totalResults 77, 40 candidates, no warning — and
// every candidate was a plumber, a painter or a mattress. The page states
// which keyword it actually applied (h1, <title>, the hydration cache) and
// the record did not carry it, so a run had no way to see that the query it
// meant was never the one the site ran.
describe('kijiji search records state the keyword the page applied', () => {
  it('reads searchTerm off the live capture (h1, title and hydration cache all say lego)', () => {
    const page = extractSearchResults(
      loadFixture('live-search-lego-toronto.html'),
      'https://www.kijiji.ca/b-toys-games/city-of-toronto/lego/k0c108l1700273',
    );
    expect(page.searchTerm).toBe('lego');
  });

  it('reads searchTerm from the quoted h1 when there is no hydration cache', () => {
    const document = parseHTML(
      `<html><head><title>77 ads for gta greater toronto area in All Categories in City of Toronto | Kijiji Marketplaces</title></head>
       <body><h1>"gta greater toronto area" in All Categories in City of Toronto</h1>
       <ul><li><a href="/v-plumbers/city-of-toronto/professional-licensed-plumber-in-gta/1742364312">Professional Licensed Plumber in GTA</a></li></ul>
       </body></html>`,
    ).document as unknown as Document;
    const page = extractSearchResults(document, 'https://www.kijiji.ca/b-lego/gta-greater-toronto-area/k0l1700273');
    expect(page.searchTerm).toBe('gta greater toronto area');
  });

  it('a category browse with no keyword reports searchTerm null', () => {
    const document = parseHTML(
      `<html><head><title>Commercial & Office Space in City of Toronto | Kijiji</title></head>
       <body><h1>Commercial & Office Space in City of Toronto</h1>
       <ul><li><a href="/v-commercial-office-space/city-of-toronto/office/1742919641">Office</a></li></ul>
       </body></html>`,
    ).document as unknown as Document;
    const page = extractSearchResults(document, 'https://www.kijiji.ca/b-commercial-office-space/city-of-toronto/c40l1700273');
    expect(page.searchTerm).toBeNull();
  });
});

describe('KEYWORD_NOT_APPLIED (kijijiKeywordWarnings)', () => {
  const quietPage = { searchTerm: 'lego', pageTitle: '3,915 ads for lego in All Categories in Toronto (GTA)' };

  it('is silent when the keyword-in-path URL and the page agree', () => {
    expect(kijijiKeywordWarnings('https://www.kijiji.ca/b-gta-greater-toronto-area/lego/k0l1700273?sort=dateDesc', quietPage)).toEqual([]);
    expect(kijijiKeywordWarnings('https://www.kijiji.ca/b-toys-games/city-of-toronto/lego/k0c108l1700273', quietPage)).toEqual([]);
    expect(kijijiKeywordWarnings('https://www.kijiji.ca/b-gta-greater-toronto-area/lego-bulk-lot/k0l1700273', { ...quietPage, searchTerm: 'Lego bulk lot' })).toEqual([]);
  });

  it('is silent on a category browse that asked for no keyword', () => {
    expect(kijijiKeywordWarnings('https://www.kijiji.ca/b-commercial-office-space/city-of-toronto/c40l1700273', { searchTerm: null, pageTitle: 'Commercial & Office Space in City of Toronto' })).toEqual([]);
  });

  it('names the mismatch when the page applied a different keyword than the URL segment', () => {
    const warnings = kijijiKeywordWarnings('https://www.kijiji.ca/b-gta-greater-toronto-area/lego/k0l1700273', {
      searchTerm: 'gta greater toronto area',
      pageTitle: '77 ads for gta greater toronto area in All Categories in City of Toronto',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^KEYWORD_NOT_APPLIED: /);
    expect(warnings[0]).toContain('"lego"');
    expect(warnings[0]).toContain('"gta greater toronto area"');
  });

  it('names the miss when a keyword URL landed on a page that applied no keyword', () => {
    const warnings = kijijiKeywordWarnings('https://www.kijiji.ca/b-lego/gta-greater-toronto-area/k0l1700273', {
      searchTerm: null,
      pageTitle: 'Buy & Sell in City of Toronto',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^KEYWORD_NOT_APPLIED: /);
    expect(warnings[0]).toContain('no keyword');
  });

  it('checks a ?q= query the same way', () => {
    expect(kijijiKeywordWarnings('https://www.kijiji.ca/b-buy-sell/canada?q=lego+lot', { searchTerm: 'lego lot', pageTitle: null })).toEqual([]);
    const warnings = kijijiKeywordWarnings('https://www.kijiji.ca/b-buy-sell/canada?q=lego+lot', { searchTerm: null, pageTitle: 'Buy & Sell in Canada' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"lego lot"');
  });
});
