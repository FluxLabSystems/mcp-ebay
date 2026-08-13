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
