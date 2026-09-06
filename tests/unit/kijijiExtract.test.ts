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

// 2026-09-04 00:16Z office fire (site-kijiji+extractor_defect+kijiji-sort-
// param-suppresses-pagination-metadata-and-does-not-sort): the same City of
// Toronto category page (c40l1700273, 1579 ads) read minutes apart returned
// hasNextPage:true / nextPageUrl / totalResults 1579 without a query string
// and hasNextPage:false / nextPageUrl:null / totalResults:null WITH
// ?sort=dateDesc — the same shape a genuine last page emits, so the caller
// could not tell "one page of 1579" from "all of them". The sorted page was
// also not date-ordered: postedAt ran 2025-10-03, 2025-10-03, 2026-08-11,
// 2026-09-03. Neither can be fixed from here (the site renders no count and
// no pagination on a sorted URL), but both must be SAID.
describe('sorted category pages (2026-09-04 office fire)', () => {
  const observedAt = new Date('2026-09-04T00:10:00Z');
  function categoryPage(postedTexts: readonly string[]): Document {
    const cards = postedTexts
      .map(
        (posted, index) => `
        <li data-testid="listing-card-${index}">
          <a href="/v-commercial-office-space/city-of-toronto/office-${index}/17429729${String(index).padStart(2, '0')}">
            <h3 data-testid="listing-title">Office ${index}</h3>
          </a>
          <div data-testid="listing-price">$1,${index}00.00</div>
          <div data-testid="listing-details"><span data-testid="listing-location">City of Toronto</span> • ${posted}</div>
        </li>`,
      )
      .join('');
    const { document } = parseHTML(
      `<html><head><title>Best Commercial &amp; Office Spaces For Rent in City of Toronto | Kijiji</title></head><body><ul>${cards}</ul></body></html>`,
    );
    return document as unknown as Document;
  }

  it('names the pagination metadata a sorted page withholds instead of reporting a last page silently', () => {
    const page = extractSearchResults(
      categoryPage(['2 hours ago', '3 hours ago', '5 hours ago']),
      'https://www.kijiji.ca/b-commercial-office-space/city-of-toronto/c40l1700273?sort=dateDesc',
      { observedAt },
    );
    expect(page.results).toHaveLength(3);
    expect(page.totalResults).toBeNull();
    expect(page.nextPageUrl).toBeNull();
    expect(page.hasNextPage).toBe(false);
    const absent = page.warnings.find((warning) => warning.startsWith('PAGINATION_METADATA_ABSENT'));
    expect(absent).toBeDefined();
    expect(absent).toMatch(/totalResults/);
    expect(absent).toMatch(/nextPageUrl/);
    expect(absent).toMatch(/hasNextPage:false/);
    // The verified path is the same category without the sort parameter.
    expect(absent).toContain('https://www.kijiji.ca/b-commercial-office-space/city-of-toronto/c40l1700273');
    expect(absent).not.toMatch(/sort=dateDesc[^ ]* and extract/);
  });

  it('says when a sort=dateDesc page is not date-ordered', () => {
    const page = extractSearchResults(
      categoryPage(['11 months ago', '11 months ago', '3 weeks ago', '1 hour ago']),
      'https://www.kijiji.ca/b-commercial-office-space/city-of-toronto/c40l1700273?sort=dateDesc',
      { observedAt },
    );
    const notSorted = page.warnings.find((warning) => warning.startsWith('SORT_NOT_HONOURED'));
    expect(notSorted).toBeDefined();
    expect(notSorted).toMatch(/sort=dateDesc/);
    expect(notSorted).toMatch(/newest/);
  });

  it('stays quiet on an unsorted page that states its count and on a sorted page that is in order', () => {
    const counted = extractSearchResults(
      loadFixture('search-results-count-only.html'),
      'https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273',
    );
    expect(counted.warnings).toEqual([]);

    const ordered = extractSearchResults(
      categoryPage(['1 hour ago', '3 hours ago', '2 days ago']),
      'https://www.kijiji.ca/b-commercial-office-space/city-of-toronto/c40l1700273?sort=dateDesc',
      { observedAt },
    );
    expect(ordered.warnings.some((warning) => warning.startsWith('SORT_NOT_HONOURED'))).toBe(false);
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

// 2026-09-05 office fire (site-kijiji+extractor_defect+mls-syndicated-ad-
// description-truncated-and-attributes-empty): browser_extract_many returned
// a description of 490 characters ending mid-word on an MLS-syndicated
// commercial ad, with nothing saying it was cut. The cut IS the record's own
// 500-character excerpt bound (an untrusted-data limit that stays); the
// defect is that it was silent, so a run could not tell a terse ad from a
// cut one — and on that ad the cut section is where square footage and
// lease terms sat. The empty attributes[] half of the same report needs a
// captured MLS-template page and is not pinned here.
describe('description excerpt says when it is cut (2026-09-05)', () => {
  const vip = (body: string): Document =>
    parseHTML(
      `<html><head><title>Office space | Kijiji</title><link rel="canonical" href="https://www.kijiji.ca/v-commercial-office-space/oakville-halton-region/302-08-3390-south-service-road/1738813761"></head>
       <body><h1>302-08 - 3390 South Service Road, Burlington</h1><div data-testid="vip-price">$730</div>
       <div data-testid="vip-description-wrapper">${body}</div></body></html>`,
    ).document as unknown as Document;
  const sentence = 'Professional office suite in a well-managed building with ample parking and on-site management. ';

  it('warns DESCRIPTION_TRUNCATED with the observed length when the body exceeds the 500-character excerpt', () => {
    const body = sentence.repeat(12); // ~1,150 characters
    const { record, warnings } = extractKijijiListing(vip(body), 'https://www.kijiji.ca/v-commercial-office-space/oakville-halton-region/x/1738813761');
    expect(record.description?.value.length).toBe(500);
    const cut = warnings.find((warning) => warning.startsWith('DESCRIPTION_TRUNCATED'));
    expect(cut).toBeDefined();
    expect(cut).toMatch(new RegExp(`${body.trim().length} characters`));
    expect(cut).toMatch(/500/);
  });

  it('stays silent on a body that fits the excerpt', () => {
    const { record, warnings } = extractKijijiListing(vip(sentence.repeat(3)), 'https://www.kijiji.ca/v-commercial-office-space/oakville-halton-region/x/1738813761');
    expect(record.description?.value.length).toBeLessThan(500);
    expect(warnings.some((warning) => warning.startsWith('DESCRIPTION_TRUNCATED'))).toBe(false);
  });
});

// 2026-09-06 deals fire (site-kijiji+extractor_defect+search-card-postedat-
// synthesised-from-fetch-time-and-can-be-a-year-wrong): on three live search
// pages nearly every card's postedAt carried the fetch clock's sub-second
// component (04:13:09.857Z across a whole page), and ad 1723674721 came back
// as 2026-09-06T02:13:09.857Z from a card whose own page states
// 2025-08-29 — 373 days apart. A relative label ("2 hrs ago") is the ad's
// last ACTIVATION as the card rounds it, measured back from the fetch
// clock; it is neither an observation of an instant nor the original
// posting date. The card must say which of the two it carried.
describe('kijiji search-card postedAt provenance (2026-09-06 deals fire)', () => {
  const observedAt = new Date('2026-09-06T04:13:09.857Z');
  const PAGE_URL = 'https://www.kijiji.ca/b-gta-greater-toronto-area/server-cabinet/k0l1700272';

  function card(adId: string, posted: string): string {
    return `
      <li data-testid="listing-card-${adId}">
        <a href="/v-servers/oakville-halton-region/cabinet-${adId}/${adId}"><h3 data-testid="listing-title">Cabinet ${adId}</h3></a>
        <div data-testid="listing-price">$450.00</div>
        <div data-testid="listing-details"><span data-testid="listing-location">Oakville</span> • ${posted}</div>
      </li>`;
  }

  function page(cards: string, apollo: Record<string, unknown> | null = null): Document {
    const nextData =
      apollo === null
        ? ''
        : `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
            props: { pageProps: { __APOLLO_STATE__: apollo } },
          })}</script>`;
    const { document } = parseHTML(
      `<html><head><title>12 ads for server cabinet in Toronto (GTA) | Kijiji</title>${nextData}</head><body><ul>${cards}</ul></body></html>`,
    );
    return document as unknown as Document;
  }

  it('truncates a relative-label postedAt to the label\'s unit and says it was derived, never the fetch clock', () => {
    const result = extractSearchResults(
      page(card('1723674721', '2 hrs ago') + card('1723674722', '1 day ago') + card('1723674723', '3 wks ago') + card('1723674724', '5 min ago')),
      PAGE_URL,
      { observedAt },
    );
    expect(result.results.map((row) => row.postedAt)).toEqual([
      '2026-09-06T02:00:00.000Z',
      '2026-09-05T00:00:00.000Z',
      '2026-08-16T00:00:00.000Z',
      '2026-09-06T04:08:00.000Z',
    ]);
    expect(result.results.map((row) => row.postedAtSource)).toEqual(['relative_text', 'relative_text', 'relative_text', 'relative_text']);
    expect(result.results.map((row) => row.postedAtPrecision)).toEqual(['hour', 'day', 'week', 'minute']);
    // The fetch clock's own time component never survives into a card.
    for (const row of result.results) expect(row.postedAt).not.toMatch(/09\.857Z$/);
    const derived = result.warnings.find((warning) => warning.startsWith('POSTED_AT_FROM_RELATIVE_LABEL'));
    expect(derived).toBeDefined();
    expect(derived).toContain('4 of 4');
    expect(derived).toContain('2026-09-06T04:13:09.857Z');
    expect(derived).toMatch(/activation/i);
    expect(derived).toMatch(/original posting date/i);
  });

  it('prefers the activation date the hydration cache states over the relative label', () => {
    const result = extractSearchResults(
      page(card('1723674721', '2 hrs ago'), {
        'StandardListing:1723674721': { __typename: 'StandardListing', id: '1723674721', activationDate: '2025-08-29T00:00:00.000Z' },
      }),
      PAGE_URL,
      { observedAt },
    );
    expect(result.results[0]).toMatchObject({
      postedText: '2 hrs ago',
      postedAt: '2025-08-29T00:00:00.000Z',
      postedAtSource: 'hydration',
      postedAtPrecision: 'exact',
    });
    expect(result.warnings.some((warning) => warning.startsWith('POSTED_AT_FROM_RELATIVE_LABEL'))).toBe(false);
  });

  it('prefers a machine-readable datetime on the card over the relative label', () => {
    const result = extractSearchResults(
      page(
        `<li data-testid="listing-card-1720698002">
          <a href="/v-servers/city-of-toronto/rack/1720698002"><h3 data-testid="listing-title">Rack</h3></a>
          <div data-testid="listing-details"><span data-testid="listing-location">Toronto</span> • <time datetime="2025-07-11T03:00:39.000Z">11 months ago</time></div>
        </li>`,
      ),
      PAGE_URL,
      { observedAt },
    );
    expect(result.results[0]).toMatchObject({
      postedAt: '2025-07-11T03:00:39.000Z',
      postedAtSource: 'card_datetime',
      postedAtPrecision: 'exact',
    });
  });

  it('counts only the derived cards, and leaves a card with no posted time null on all three fields', () => {
    const result = extractSearchResults(
      page(card('1723674721', '2 hrs ago') + card('1736311009', ''), {
        'StandardListing:1736311009': { activationDate: '2026-04-20T20:33:52.000Z' },
      }),
      PAGE_URL,
      { observedAt },
    );
    expect(result.results[1]).toMatchObject({ postedAt: '2026-04-20T20:33:52.000Z', postedAtSource: 'hydration' });
    const derived = result.warnings.find((warning) => warning.startsWith('POSTED_AT_FROM_RELATIVE_LABEL'));
    expect(derived).toContain('1 of 2');
    const bare = extractSearchResults(page(card('1723674799', '')), PAGE_URL, { observedAt });
    expect(bare.results[0]).toMatchObject({ postedText: null, postedAt: null, postedAtSource: null, postedAtPrecision: null });
    expect(bare.warnings.some((warning) => warning.startsWith('POSTED_AT_FROM_RELATIVE_LABEL'))).toBe(false);
  });
});
