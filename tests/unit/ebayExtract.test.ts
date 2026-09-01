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

// Defects a LEGO deals run surfaced on 2026-08-29. Each one cost the run an
// extra browser.snapshot call to work around, which is what exhausted the
// per-turn tool budget. Fixtures are synthetic reconstructions -- www.ebay.ca
// answers this box with HTTP 403 -- and each carries a sidecar .json saying so.
describe('defects the 2026-08-29 deals run surfaced', () => {
  // --- defect 1: ended/sold false negative on the "See original listing" template ---
  it('reads the ended-item template as ended even with no banner sentence', () => {
    // The page carries none of the ENDED_MARKERS sentences. What says it is
    // over is the combination: an original-listing/relist affordance on a
    // buybox that offers no way to bid or buy.
    const { record } = extractListing(
      loadFixture('ended-see-original-listing.html'),
      'https://www.ebay.ca/itm/198589141532',
    );
    expect(record.listingStatus).toBe('ended');
  });

  it('does not end a live listing that merely offers "Sell one like this"', () => {
    // eBay shows that link to a seller on their own running listing, so the
    // phrase alone must never be the whole rule -- here the Buy It Now is
    // still there and the listing is still active.
    const { record } = extractListing(
      loadFixture('active-sell-one-like-this.html'),
      'https://www.ebay.ca/itm/227489965462',
    );
    expect(record.listingStatus).toBe('active');
  });

  it('does not let a similar-items strip end a live auction', () => {
    // The strip on the live-auction fixture is the same markup the ended page
    // carries below the fold; only the buybox decides.
    expect(
      extractListing(loadFixture('auction-live-timer.html'), 'https://www.ebay.ca/itm/366630546269').record
        .listingStatus,
    ).toBe('active');
  });

  // --- defect 2: no auction end time anywhere on the record ---
  it('reads the auction end time off the timer element', () => {
    const { record } = extractListing(
      loadFixture('auction-live-timer.html'),
      'https://www.ebay.ca/itm/366630546269',
    );
    expect(record.endsAt).toMatchObject({ value: '2026-09-03T18:30:00.000Z', source: 'dom' });
    expect(record.timeLeftText?.value).toBe('5d 04h left (Thu, 02:30 PM)');
  });

  it('computes an end time from the rendered countdown when no attribute carries it', () => {
    const { record } = extractListing(
      loadFixture('active-sell-one-like-this.html'),
      'https://www.ebay.ca/itm/227489965462',
      { observedAt: new Date('2026-08-29T12:00:00.000Z') },
    );
    // "Ends in 2d 03h 15m" is only as precise as the minute it renders, so the
    // derived value is 'computed' and carries less confidence than a read one.
    expect(record.endsAt).toMatchObject({ value: '2026-08-31T15:15:00.000Z', source: 'computed' });
    expect(record.endsAt!.confidence).toBeLessThan(0.9);
    expect(record.timeLeftText?.value).toBe('Ends in 2d 03h 15m');
  });

  it('leaves the end time null rather than inventing one when the page shows no countdown', () => {
    const { record } = extractListing(
      loadFixture('fixed-price-listing.html'),
      'https://www.ebay.ca/itm/421150000002',
    );
    expect(record.endsAt).toBeNull();
    expect(record.timeLeftText).toBeNull();
  });

  // --- defect 5: offer.available true on every listing ---
  it('does not read a similar-items strip as a Best Offer on this listing', () => {
    // The auction fixture's only "Best Offer" text is a card about a different
    // item plus the inline script bundle -- and linkedom's body.textContent
    // includes script text, so the old whole-body test answered true here.
    const { record } = extractListing(
      loadFixture('auction-live-timer.html'),
      'https://www.ebay.ca/itm/366630546269',
    );
    expect(record.offer.available).toBe(false);
  });

  it('still sees a Make offer control that is actually on the listing', () => {
    const { record } = extractListing(loadFixture('active-listing.html'), 'https://www.ebay.ca/itm/123456789012');
    expect(record.offer.available).toBe(true);
  });

  // --- defect 6: additive item fields ---
  it('reads watchers, quantity sold and item location when the page shows them', () => {
    const { record } = extractListing(
      loadFixture('auction-live-timer.html'),
      'https://www.ebay.ca/itm/366630546269',
    );
    expect(record.watcherCount?.value).toBe(48);
    expect(record.quantityAvailable?.value).toBe(1);
    expect(record.quantitySold?.value).toBe(12);
    expect(record.itemLocationText?.value).toBe('Mississauga, Ontario, Canada');
  });

  // 2026-09-01 live run: a listing whose location row renders under the
  // "Item location:" wording, with the value nested one level deeper than
  // .ux-labels-values__values, came back itemLocationText: null.
  it('reads the location from templates that label it "Item location"', () => {
    const nested = parseHTML(
      `<h1 class="x-item-title__mainTitle">LEGO Bulk Lot 4 lbs</h1>
       <div class="x-price-primary">C $20.00</div>
       <div class="ux-labels-values--itemLocation">
         <div class="ux-labels-values__labels">Item location:</div>
         <div class="ux-labels-values__values-content">Etobicoke, Ontario, Canada</div>
       </div>`,
    ).document as unknown as Document;
    const nestedRecord = extractListing(nested, 'https://www.ebay.ca/itm/335544667788').record;
    expect(nestedRecord.itemLocationText?.value).toBe('Etobicoke, Ontario, Canada');

    const rowOnly = parseHTML(
      `<h1 class="x-item-title__mainTitle">LEGO Bulk Lot 4 lbs</h1>
       <div class="x-price-primary">C $20.00</div>
       <div class="ux-labels-values--itemLocation">Item location: North York, Ontario, Canada</div>`,
    ).document as unknown as Document;
    const rowRecord = extractListing(rowOnly, 'https://www.ebay.ca/itm/335544667789').record;
    expect(rowRecord.itemLocationText?.value).toBe('North York, Ontario, Canada');
  });

  it('records "More than 10 available" as a floor rather than a count', () => {
    const { record } = extractListing(
      loadFixture('active-sell-one-like-this.html'),
      'https://www.ebay.ca/itm/227489965462',
    );
    expect(record.quantityAvailable?.value).toBe(10);
    // The page says more than ten, not ten; the number is a lower bound.
    expect(record.quantityAvailable!.confidence).toBeLessThan(0.8);
  });

  it('leaves the added fields null on a page that shows none of them', () => {
    const { record } = extractListing(
      loadFixture('fixed-price-listing.html'),
      'https://www.ebay.ca/itm/421150000002',
    );
    expect(record.watcherCount).toBeNull();
    expect(record.quantitySold).toBeNull();
    expect(record.itemLocationText).toBeNull();
  });

  it('keeps every widened record validating against the canonical schema', () => {
    for (const [fixture, url] of [
      ['auction-live-timer.html', 'https://www.ebay.ca/itm/366630546269'],
      ['active-sell-one-like-this.html', 'https://www.ebay.ca/itm/227489965462'],
      ['ended-see-original-listing.html', 'https://www.ebay.ca/itm/198589141532'],
    ] as const) {
      expect(ExtractionRecordSchema.safeParse(extractListing(loadFixture(fixture), url).record).success).toBe(true);
    }
  });
});
