import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  classifyEbayPage,
  extractListing,
  extractListingCandidates,
  ExtractionRecordSchema,
  readDestinationPostal,
} from '@browser-bridge/site-ebay';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ebay');

function loadFixture(name: string): Document {
  const html = readFileSync(join(FIXTURES, name), 'utf8');
  return parseHTML(html).document as unknown as Document;
}

describe('ebay.ca.v1 listing extraction (FR-08, §20)', () => {
  it('extracts the active listing with provenance and destination-verified shipping', () => {
    const document = loadFixture('active-listing.html');
    const { record, warnings } = extractListing(document, 'https://www.ebay.ca/itm/123456789012', {
      expectedPostalCode: 'M6H 2W9',
      pageRevision: 3,
    });

    expect(ExtractionRecordSchema.parse(record)).toBeTruthy();
    expect(record.itemId).toMatchObject({ value: '123456789012', confidence: 1.0 });
    expect(record.canonicalUrl).toMatchObject({
      value: 'https://www.ebay.ca/itm/123456789012',
      source: 'computed',
    });
    expect(record.title?.value).toContain('LEGO Friends Bulk Lot');
    expect(record.seller).toMatchObject({ value: 'brickdeals_toronto', source: 'dom' });
    expect(record.itemPrice).toMatchObject({ value: 35, currency: 'CAD' });
    expect(record.shipping).toMatchObject({
      value: 8.91,
      currency: 'CAD',
      destinationPostalCode: 'M6H 2W9',
      destinationVerified: true,
    });
    expect(record.offer.available).toBe(true);
    expect(record.variants?.hasVariants).toBe(true);
    expect(record.variants?.selections[0]?.selected).toBe('Friends heavy');
    expect(record.listingStatus).toBe('active');
    expect(record.pageRevision).toBe(3);
    expect(warnings.some((warning) => warning.includes('DESTINATION_UNVERIFIED'))).toBe(false);
  });

  it('never marks proxy-destination shipping as verified (§20.1 step 6)', () => {
    const document = loadFixture('active-listing-proxy-destination.html');
    const { record, warnings } = extractListing(document, 'https://www.ebay.com/itm/987654321098', {
      expectedPostalCode: 'M6H 2W9',
    });
    expect(record.shipping?.destinationVerified).toBe(false);
    expect(record.shipping?.destinationPostalCode).toBe('K1A 0B1');
    expect(record.canonicalUrl?.value).toBe('https://www.ebay.com/itm/987654321098');
    expect(warnings.some((warning) => warning.includes('DESTINATION_UNVERIFIED'))).toBe(true);
  });

  it('live verification overrides DOM text and downgrades on mismatch', () => {
    const document = loadFixture('active-listing.html');
    const { record } = extractListing(document, 'https://www.ebay.ca/itm/123456789012', {
      expectedPostalCode: 'M6H 2W9',
      verifiedDestination: { postalCode: 'K1A 0B1', verified: false },
    });
    expect(record.shipping?.destinationVerified).toBe(false);
  });

  it('detects ended and unavailable listings (§20.2)', () => {
    expect(extractListing(loadFixture('ended-listing.html'), 'https://www.ebay.ca/itm/222333444555').record.listingStatus).toBe(
      'ended',
    );
    expect(
      extractListing(loadFixture('unavailable-listing.html'), 'https://www.ebay.ca/itm/000000000000').record.listingStatus,
    ).toBe('unavailable');
  });

  it('reads the destination indicator from rendered DOM', () => {
    expect(readDestinationPostal(loadFixture('active-listing.html'))).toBe('M6H 2W9');
    expect(readDestinationPostal(loadFixture('active-listing-proxy-destination.html'))).toBe('K1A 0B1');
  });
});

describe('search/store traversal (FR-15)', () => {
  it('classifies eBay page kinds', () => {
    expect(classifyEbayPage('https://www.ebay.ca/itm/1234567890')).toBe('listing');
    expect(classifyEbayPage('https://www.ebay.ca/sch/i.html?_nkw=lego')).toBe('search');
    expect(classifyEbayPage('https://www.ebay.ca/str/brickdeals')).toBe('store');
    expect(classifyEbayPage('https://www.ebay.ca/')).toBe('other');
  });

  it('extracts deduplicated candidates in display order from search results', () => {
    const document = loadFixture('search-results.html');
    const candidates = extractListingCandidates(document, 'https://www.ebay.ca/sch/i.html?_nkw=bulk+lego');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ itemId: '123456789012', order: 0 });
    expect(candidates[0]?.snippetPrice).toEqual({ value: 35, currency: 'CAD' });
    expect(candidates[1]).toMatchObject({ itemId: '222333444555', order: 1 });
  });

  it('extracts candidates from seller store pages', () => {
    const document = loadFixture('seller-store.html');
    const candidates = extractListingCandidates(document, 'https://www.ebay.ca/str/brickdeals');
    expect(candidates.map((candidate) => candidate.itemId)).toEqual(['555666777888', '123456789012']);
  });
});

// Four defects a live end-to-end run surfaced on 2026-08-26. Each fixture
// fails against the extractor as it stood before this suite was added.
describe('defects found on the first live extraction run', () => {
  const SOLD_AUCTION_URL = 'https://www.ebay.ca/itm/751920000001';

  function soldAuction() {
    return extractListing(loadFixture('sold-auction-listing.html'), SOLD_AUCTION_URL, {
      expectedPostalCode: 'M6H 2W9',
    });
  }

  it('keeps the real shipping cost when the cell also advertises free returns', () => {
    const { record } = soldAuction();
    // Was 0: a bare /free/ test matched "Free returns" and won over the
    // amount, so observedText showed C $28.36 while value said nothing to pay.
    expect(record.shipping?.value).toBe(28.36);
    expect(record.shipping?.currency).toBe('CAD');
    expect(record.shipping?.observedText).toContain('28.36');
  });

  it('reports a sold listing as sold, not unknown', () => {
    // The banner uses .x-status-message, which the original selector list did
    // not carry -- so a plainly sold listing came back "unknown".
    expect(soldAuction().record.listingStatus).toBe('sold');
  });

  it('distinguishes an auction bid from a fixed price', () => {
    const { record, warnings } = soldAuction();
    expect(record.sellingFormat.kind).toBe('auction');
    expect(record.sellingFormat.bidCount).toBe(37);
    // itemPrice on an auction is a live bid, not something purchasable.
    expect(warnings.some((warning) => warning.startsWith('AUCTION_PRICE'))).toBe(true);
  });

  it('reads a fixed-price listing as fixed price with no bid count', () => {
    const { record, warnings } = extractListing(
      loadFixture('fixed-price-listing.html'),
      'https://www.ebay.ca/itm/421150000002',
      { expectedPostalCode: 'M6H 2W9' },
    );
    expect(record.sellingFormat.kind).toBe('fixed_price');
    expect(record.sellingFormat.bidCount).toBeNull();
    expect(warnings.some((warning) => warning.startsWith('AUCTION_PRICE'))).toBe(false);
    // Genuinely free shipping still reads as 0.
    expect(record.shipping?.value).toBe(0);
  });

  it('strips badge spans and screen-reader text from the item title', () => {
    // textContent concatenates the "New Listing" badge and the clipped
    // "Opens in a new window or tab" into the h1.
    expect(soldAuction().record.title?.value).toBe('LEGO Star Wars UCS Millennium Falcon 75192');
  });

  it('still validates against the canonical record schema', () => {
    expect(ExtractionRecordSchema.safeParse(soldAuction().record).success).toBe(true);
  });
});
