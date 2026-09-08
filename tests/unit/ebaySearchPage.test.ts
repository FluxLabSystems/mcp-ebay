/**
 * The eBay search page's page-level reads — improvement queue, deals
 * 2026-09-07T19:31Z and 19:56Z files:
 *
 * - site-ebay+extractor_defect+ssn-seller-search-returns-no-totalresults-or-nextpage
 * - site-ebay+extractor_defect+seller-search-row-attributes-listing-to-wrong-seller
 *
 * Before 2026-09-08 an _ssn= page returned only the page-local counts, and
 * every row of a seller search was, by omission, the seller's. Fixtures are
 * SYNTHETIC (www.ebay.ca 403s dev boxes) and the selectors they exercise are
 * NEEDS-LIVE-VERIFICATION; the reads are the watch list's, which live
 * captures did pin.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  extractListingCandidates,
  extractSearchPageMeta,
  readSearchResultCount,
  sellerQueryOf,
  type ListingCandidate,
} from '@browser-bridge/site-ebay';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ebay');

function loadFixture(name: string): Document {
  const html = readFileSync(join(FIXTURES, name), 'utf8');
  return parseHTML(html).document as unknown as Document;
}

const SSN_PAGE_1 = 'https://www.ebay.ca/sch/i.html?_ssn=dkbooksandtreasures&_sop=10&_ipg=240';
const SSN_PAGE_3_CLAMPED = 'https://www.ebay.ca/sch/i.html?_ssn=treasurequestca&_sop=10&_ipg=240&_pgn=3';

function readPage(fixture: string, pageUrl: string) {
  const document = loadFixture(fixture);
  const candidates = extractListingCandidates(document, pageUrl);
  const warnings: string[] = [];
  const meta = extractSearchPageMeta({ document, pageUrl, candidates, pageKind: 'search', warnings });
  return { candidates, meta, warnings };
}

function byId(candidates: ListingCandidate[], itemId: string): ListingCandidate {
  const found = candidates.find((candidate) => candidate.itemId === itemId);
  if (found === undefined) throw new Error(`no candidate for ${itemId}`);
  return found;
}

describe('an _ssn= seller search page states its total and its next page', () => {
  it('reads totalResults from the count heading and nextPageUrl from the pagination control', () => {
    const { meta, warnings } = readPage('search-seller-ssn-page.html', SSN_PAGE_1);
    expect(meta.totalResults).toBe(1113);
    expect(meta.totalCountSource).toBe('1,113 results');
    expect(meta.hasNextPage).toBe(true);
    expect(meta.nextPageUrl).toBe('https://www.ebay.ca/sch/i.html?_ssn=dkbooksandtreasures&_sop=10&_ipg=240&_pgn=2');
    expect(meta.currentPage).toBe(1);
    expect(meta.currentPageSource).toBe('pagination');
    expect(meta.requestedPage).toBeNull();
    expect(warnings.some((w) => w.startsWith('SEARCH_TOTAL_UNSTATED'))).toBe(false);
    expect(warnings.some((w) => w.startsWith('SEARCH_PAGINATION_UNSTATED'))).toBe(false);
    expect(warnings.some((w) => w.startsWith('SEARCH_PAGE_CLAMPED'))).toBe(false);
  });

  it('reads "10,000+ results" as a floor and says so', () => {
    const { document } = parseHTML(
      '<div class="srp-controls"><h1 class="srp-controls__count-heading"><span class="BOLD">10,000</span>+ results for <span class="BOLD">lego</span></h1></div>',
    );
    const read = readSearchResultCount(document as unknown as Document);
    expect(read.count).toBe(10000);
    expect(read.lowerBound).toBe(true);
  });

  // The 2026-09-07 walk: a page with no count and no pagination the readers
  // know. The page did not state them, and null is the honest answer — the
  // old record simply had no such keys, which the walk read as "no total
  // exists on this page kind".
  it('says the total and the pagination are unstated rather than absent or false', () => {
    const { meta, warnings } = readPage('search-results.html', 'https://www.ebay.ca/sch/i.html?_ssn=someseller&_sop=10&_ipg=240');
    expect(meta.totalResults).toBeNull();
    expect(meta.hasNextPage).toBeNull();
    expect(meta.nextPageUrl).toBeNull();
    expect(warnings.some((w) => w.startsWith('SEARCH_TOTAL_UNSTATED'))).toBe(true);
    const pagination = warnings.find((w) => w.startsWith('SEARCH_PAGINATION_UNSTATED'));
    expect(pagination).toBeDefined();
    // The walk rule is in the warning: open the next page number and compare ids.
    expect(pagination).toContain('_pgn=2');
    expect(pagination).toContain('identical set is the clamp');
  });
});

describe('eBay re-serves its last page for a _pgn past the end (the silent clamp)', () => {
  it('names the clamp from the selected pagination item and closes the walk', () => {
    const { meta, warnings } = readPage('search-seller-ssn-clamped.html', SSN_PAGE_3_CLAMPED);
    expect(meta.requestedPage).toBe(3);
    expect(meta.currentPage).toBe(2);
    expect(meta.currentPageSource).toBe('pagination');
    expect(meta.hasNextPage).toBe(false);
    expect(meta.nextPageUrl).toBeNull();
    const clamped = warnings.find((w) => w.startsWith('SEARCH_PAGE_CLAMPED'));
    expect(clamped).toBeDefined();
    expect(clamped).toContain('asked for page 3');
    expect(clamped).toContain('marks page 2');
    expect(clamped).toContain('count nothing from them');
  });

  it('names the clamp from the stated total alone when the widget marks no page', () => {
    const { document } = parseHTML(
      '<h1 class="srp-controls__count-heading"><span class="BOLD">463</span> results</h1><ul class="srp-results"><li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/157758966050">LEGO lot</a><span class="s-item__price">C $42.00</span></li></ul>',
    );
    const doc = document as unknown as Document;
    const candidates = extractListingCandidates(doc, SSN_PAGE_3_CLAMPED);
    const warnings: string[] = [];
    const meta = extractSearchPageMeta({ document: doc, pageUrl: SSN_PAGE_3_CLAMPED, candidates, pageKind: 'search', warnings });
    expect(meta.hasNextPage).toBe(false);
    const clamped = warnings.find((w) => w.startsWith('SEARCH_PAGE_CLAMPED'));
    expect(clamped).toContain('463 fits in 2 page(s) of 240');
  });
});

describe('a seller search row belongs to the seller only when a card says so', () => {
  it('reads the seller the card states and flags a row naming a different seller', () => {
    const { candidates, meta, warnings } = readPage('search-seller-ssn-page.html', SSN_PAGE_1);
    expect(meta.sellerQuery).toBe('dkbooksandtreasures');
    expect(byId(candidates, '227509015721').seller).toBe('fantasma713');
    expect(byId(candidates, '206521991628').seller).toBe('dkbooksandtreasures');
    expect(byId(candidates, '377354758256').seller).toBeNull();
    const mismatch = warnings.find((w) => w.startsWith('SELLER_SEARCH_ROW_MISMATCH'));
    expect(mismatch).toBeDefined();
    expect(mismatch).toContain('227509015721 → fantasma713');
    expect(mismatch).not.toContain('206521991628');
  });

  it('says how many rows state no seller, and that they are query results', () => {
    const { warnings } = readPage('search-seller-ssn-page.html', SSN_PAGE_1);
    const unattributed = warnings.find((w) => w.startsWith('SELLER_SEARCH_ROWS_UNATTRIBUTED'));
    expect(unattributed).toBeDefined();
    expect(unattributed).toContain('2 of 4 row(s)');
    expect(unattributed).toContain('candidates returned by the query');
  });

  it('marks the rows below "Results matching fewer words" as rewrite rows', () => {
    const { candidates, warnings } = readPage('search-seller-ssn-page.html', SSN_PAGE_1);
    expect(byId(candidates, '227509015721').matchScope).toBe('primary');
    expect(byId(candidates, '377354758256').matchScope).toBe('primary');
    expect(byId(candidates, '296523775920').matchScope).toBe('rewrite');
    const rewrite = warnings.find((w) => w.startsWith('SEARCH_REWRITE_ROWS'));
    expect(rewrite).toContain('1 of 4 row(s)');
    expect(rewrite).toContain('296523775920');
  });

  it('attributes nothing on a keyword search, where no seller was queried', () => {
    const { meta, warnings } = readPage('search-carousel-cards.html', 'https://www.ebay.ca/sch/i.html?_nkw=lego+bulk+lot&_sop=10');
    expect(meta.sellerQuery).toBeNull();
    expect(warnings.some((w) => w.startsWith('SELLER_SEARCH'))).toBe(false);
    expect(sellerQueryOf('https://www.ebay.ca/sch/i.html?_nkw=lego')).toBeNull();
    expect(sellerQueryOf('https://www.ebay.ca/sch/i.html?_ssn=magellan_store&_sop=10')).toBe('magellan_store');
  });
});

// 2026-09-08 deals fire (site-ebay+extractor_defect+search-card-seller-and-
// location-null-on-every-row-of-a-broad-sch-page): the report asked for a
// page-level warning that separates "this template renders no seller line"
// from "the selector missed". With the text fallback in place, a page whose
// rows all read their seller from card text is a selector miss to pin, and a
// page whose rows carry no seller-shaped text at all renders none.
describe('page-level seller and location provenance (2026-09-08)', () => {
  const BROAD = 'https://www.ebay.ca/sch/i.html?_nkw=lego+minifigure+lot&_sop=10&_ipg=240';
  const cards = (attributes: string) =>
    parseHTML(
      `<html><body><h1 class="srp-controls__count-heading"><span class="BOLD">2</span> results for lego minifigure lot</h1>
       <div class="srp-river-results">
         <div class="su-card-container"><a class="su-link" href="https://www.ebay.ca/itm/336123456789"><img src="a.jpg"></a><span class="s-card__title">LEGO minifigure lot 40 figures</span><span class="s-card__price">C $59.99</span><div class="su-card-container__attributes">${attributes}</div></div>
         <div class="su-card-container"><a class="su-link" href="https://www.ebay.ca/itm/336123456790"><img src="b.jpg"></a><span class="s-card__title">LEGO minifigure lot 12 figures</span><span class="s-card__price">C $19.99</span><div class="su-card-container__attributes">${attributes}</div></div>
       </div></body></html>`,
    ).document as unknown as Document;

  function warningsFor(attributes: string): string[] {
    const document = cards(attributes);
    const candidates = extractListingCandidates(document, BROAD);
    const warnings: string[] = [];
    extractSearchPageMeta({ document, pageUrl: BROAD, candidates, pageKind: 'search', warnings });
    return warnings;
  }

  it('names the selector miss when every seller and location came from card text', () => {
    const warnings = warningsFor('<span class="su-styled-text">brickvault_ca (1,234) 99.5%</span><span class="su-styled-text">Located in Canada</span>');
    const seller = warnings.find((w) => w.startsWith('CARD_SELLER_SELECTOR_MISSED'));
    expect(seller).toBeDefined();
    expect(seller).toMatch(/2 of 2/);
    expect(seller).toMatch(/336123456789/);
    const location = warnings.find((w) => w.startsWith('CARD_LOCATION_SELECTOR_MISSED'));
    expect(location).toBeDefined();
    expect(warnings.some((w) => w.startsWith('CARD_SELLER_UNRENDERED'))).toBe(false);
  });

  it('says the template renders no seller line or location when no card carries either', () => {
    const warnings = warningsFor('<span class="su-styled-text">Free shipping</span>');
    const seller = warnings.find((w) => w.startsWith('CARD_SELLER_UNRENDERED'));
    expect(seller).toBeDefined();
    expect(seller).toMatch(/2 card\(s\)/);
    expect(seller).toMatch(/item page/);
    expect(warnings.find((w) => w.startsWith('CARD_LOCATION_UNRENDERED'))).toBeDefined();
    expect(warnings.some((w) => w.startsWith('CARD_SELLER_SELECTOR_MISSED'))).toBe(false);
  });

  it('stays silent when the named elements read', () => {
    const warnings = warningsFor('<span class="s-item__seller-info-text">brickvault_ca (1,234) 99.5%</span><span class="s-item__location">from Toronto, ON, Canada</span>');
    expect(warnings.some((w) => /^CARD_(SELLER|LOCATION)_/.test(w))).toBe(false);
  });
});
