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
// extra browser_snapshot call to work around, which is what exhausted the
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

// C2 (2026-09-03 deals fire): item-page seller field returned the /str/ store
// slug for some sellers, which then failed as an _ssn= login id (magellanstore)
// and made a live seller read as "no inventory". The extractor must prefer a
// /usr/ login id and, when only a store slug is readable, flag it rather than
// pass the slug off as a login id.
describe('seller login id vs store slug (C2)', () => {
  it('records only a store slug as sellerStoreSlug and withholds seller, with SELLER_LOGIN_ID_UNAVAILABLE', () => {
    const document = parseHTML(
      `<h1 class="x-item-title__mainTitle">LEGO Bulk Lot</h1>
       <div class="x-price-primary">C $25.00</div>
       <div class="x-sellercard-atf">
         <div class="x-sellercard-atf__info__about-seller">
           <a href="https://www.ebay.ca/str/magellanstore"><span>Magellan Store</span></a>
         </div>
       </div>`,
    ).document as unknown as Document;
    const { record, warnings } = extractListing(document, 'https://www.ebay.ca/itm/257719232683');
    expect(record.seller).toBeNull();
    expect(record.sellerStoreSlug?.value).toBe('magellanstore');
    expect(record.sellerProfileUrl?.value).toBe('https://www.ebay.ca/str/magellanstore');
    expect(warnings.some((w) => w.startsWith('SELLER_LOGIN_ID_UNAVAILABLE'))).toBe(true);
  });

  it('prefers the /usr/ login id even when a /str/ store link appears first on the card', () => {
    const document = parseHTML(
      `<h1 class="x-item-title__mainTitle">LEGO Bulk Lot</h1>
       <div class="x-price-primary">C $25.00</div>
       <div class="x-sellercard-atf">
         <div class="x-sellercard-atf__info__about-seller">
           <a href="https://www.ebay.ca/str/scottstoyemporium"><span>Scott's Toy Emporium</span></a>
         </div>
         <a href="https://www.ebay.ca/usr/novanut74">novanut74</a>
       </div>`,
    ).document as unknown as Document;
    const { record, warnings } = extractListing(document, 'https://www.ebay.ca/itm/257679218767');
    expect(record.seller).toMatchObject({ value: 'novanut74', source: 'dom' });
    expect(record.sellerStoreSlug?.value).toBe('scottstoyemporium');
    expect(warnings.some((w) => w.startsWith('SELLER_LOGIN_ID_UNAVAILABLE'))).toBe(false);
  });
});

// C3 (2026-09-03 deals fire): itemLocationText returned a truncated fragment of
// eBay's delivery-estimate disclaimer (", the shipping service selected, the
// seller's shipping history, and other factor") instead of the location, which
// was still present as a "Located in:" span in the shipping module.
describe('item location rejects the delivery-estimate disclaimer (C3)', () => {
  it('skips the disclaimer fragment and reads the "Located in:" span from shipping', () => {
    const document = parseHTML(
      `<h1 class="x-item-title__mainTitle">LEGO Bulk Lot</h1>
       <div class="x-price-primary">C $30.00</div>
       <div class="ux-labels-values--itemLocation">
         <div class="ux-labels-values__values">, the shipping service selected, the seller's shipping history, and other factor</div>
       </div>
       <div class="ux-labels-values--shipping">
         <div class="ux-labels-values__values">C $18.00 Standard Shipping. Located in: Prince Albert, Saskatchewan, Canada</div>
       </div>`,
    ).document as unknown as Document;
    const { record } = extractListing(document, 'https://www.ebay.ca/itm/128056737473');
    expect(record.itemLocationText?.value).toBe('Prince Albert, Saskatchewan, Canada');
  });

  it('returns null rather than the disclaimer when no real location is present', () => {
    const document = parseHTML(
      `<h1 class="x-item-title__mainTitle">LEGO Bulk Lot</h1>
       <div class="x-price-primary">C $30.00</div>
       <div class="ux-labels-values--itemLocation">
         <div class="ux-labels-values__values">Delivery time is estimated using our proprietary method which is based on the buyer's proximity to the item location</div>
       </div>`,
    ).document as unknown as Document;
    const { record } = extractListing(document, 'https://www.ebay.ca/itm/820076179536');
    expect(record.itemLocationText).toBeNull();
  });
});

// 2026-09-04 deals fire (site-ebay+extractor_defect+shipping-currency-
// mislabelled-on-foreign-quotes): 293552114051 returned shipping {value 5,
// currency 'CAD'} while the cell read "AU $5.00 (approx C $4.97)"; GBP quotes
// (398228632090, 389699863267) did the same. A landed figure built from
// those fields was wrong by the FX rate, and only observedText showed it.
describe('shipping quoted in a foreign currency (2026-09-04)', () => {
  function pageWithShipping(cell: string): Document {
    return parseHTML(
      `<h1 class="x-item-title__mainTitle">LEGO Bulk Lot</h1>
       <div class="x-price-primary">C $30.00</div>
       <div class="ux-labels-values--shipping">
         <div class="ux-labels-values__values">${cell}</div>
       </div>`,
    ).document as unknown as Document;
  }

  it('records the page\'s own CAD conversion, never the foreign amount under a CAD label', () => {
    const { record, warnings } = extractListing(
      pageWithShipping('AU $5.00 (approx C $4.97) Australia Post International Standard'),
      'https://www.ebay.ca/itm/293552114051',
    );
    expect(record.shipping?.value).toBe(4.97);
    expect(record.shipping?.currency).toBe('CAD');
    expect(record.shipping?.observedText).toContain('AU $5.00');
    expect(warnings.some((w) => w.startsWith('SHIPPING_CONVERTED_BY_PAGE') && w.includes('AUD 5'))).toBe(true);
  });

  it('keeps the quoted currency when the page renders no conversion', () => {
    const { record, warnings } = extractListing(
      pageWithShipping('GBP 33.05 Royal Mail International Tracked'),
      'https://www.ebay.ca/itm/398228632090',
    );
    expect(record.shipping?.value).toBe(33.05);
    expect(record.shipping?.currency).toBe('GBP');
    expect(warnings.some((w) => w.startsWith('SHIPPING_FOREIGN_CURRENCY') && w.includes('GBP'))).toBe(true);
  });

  it('leaves a domestic quote untouched and unwarned', () => {
    const { record, warnings } = extractListing(
      pageWithShipping('C $18.00 Standard Shipping'),
      'https://www.ebay.ca/itm/128056737473',
    );
    expect(record.shipping?.value).toBe(18);
    expect(record.shipping?.currency).toBe('CAD');
    expect(warnings.some((w) => w.startsWith('SHIPPING_CONVERTED_BY_PAGE') || w.startsWith('SHIPPING_FOREIGN_CURRENCY'))).toBe(false);
  });
});

// 2026-09-04 deals fire (site-ebay+extractor_defect+item-endsat-null-on-live-
// auctions): endsAt came back null on 326 of 328 item pages, live auctions
// with 17–22 bids included, and timeLeftText was null beside it — so no
// timer selector matched the common template at all, while the bid count
// (read from the same buy box) did. The countdown was on the page; the
// extractor only knew how to find it under a timer class.
describe('auction end time when no timer element matches (2026-09-04)', () => {
  it('reads a countdown phrase out of the buy-box text and computes an end time from it', () => {
    const document = parseHTML(
      `<div class="x-buybox">
         <h1 class="x-item-title__mainTitle">LEGO Minifigure Lot</h1>
         <div class="x-price-primary">C $41.00</div>
         <div class="x-bid-count">17 bids</div>
         <div class="x-end-time"><span>Ends in 1d 3h 22m</span><span>(Sat, 05:24 p.m.)</span></div>
         <div class="x-bid-action"><a href="https://www.ebay.ca/bidflow?item=407119899015" role="button">Place bid</a></div>
       </div>`,
    ).document as unknown as Document;
    const { record, warnings } = extractListing(document, 'https://www.ebay.ca/itm/407119899015', {
      observedAt: new Date('2026-09-04T07:30:00.000Z'),
    });
    expect(record.sellingFormat.bidCount).toBe(17);
    expect(record.timeLeftText?.value).toBe('Ends in 1d 3h 22m');
    // Read from unlabelled text, so it says so and trusts itself less than a
    // timer element (0.95) would.
    expect(record.timeLeftText!.confidence).toBeLessThan(0.95);
    expect(record.endsAt).toMatchObject({ value: '2026-09-05T10:52:00.000Z', source: 'computed' });
    expect(record.endsAt!.confidence).toBeLessThan(0.6);
    expect(warnings.some((warning) => warning.startsWith('END_TIME_FROM_TEXT'))).toBe(true);
  });

  it('accepts the "Nd Nh left" form too', () => {
    const document = parseHTML(
      `<div class="x-buybox">
         <div class="x-price-primary">C $12.50</div>
         <div>19 bids</div>
         <div>2d 05h left</div>
       </div>`,
    ).document as unknown as Document;
    const { record } = extractListing(document, 'https://www.ebay.ca/itm/158149563572', {
      observedAt: new Date('2026-09-04T07:30:00.000Z'),
    });
    expect(record.timeLeftText?.value).toBe('2d 05h left');
    expect(record.endsAt?.value).toBe('2026-09-06T12:30:00.000Z');
  });

  it('does not read a promo countdown outside the buy box as the auction end', () => {
    const document = parseHTML(
      `<div id="mainContent">
         <div class="x-buybox">
           <h1 class="x-item-title__mainTitle">LEGO Minifigure Lot</h1>
           <div class="x-price-primary">C $41.00</div>
           <div class="x-bid-count">22 bids</div>
         </div>
         <div class="x-similar-items"><span>Sale ends in 2d 04h — shop the event</span></div>
       </div>`,
    ).document as unknown as Document;
    const { record, warnings } = extractListing(document, 'https://www.ebay.ca/itm/267747547748');
    expect(record.sellingFormat.bidCount).toBe(22);
    expect(record.endsAt).toBeNull();
    expect(record.timeLeftText).toBeNull();
    expect(warnings.some((warning) => warning.startsWith('END_TIME_FROM_TEXT'))).toBe(false);
  });

  it('a timer element still wins over the text scan', () => {
    const { record, warnings } = extractListing(
      loadFixture('auction-live-timer.html'),
      'https://www.ebay.ca/itm/366630546269',
    );
    expect(record.endsAt).toMatchObject({ value: '2026-09-03T18:30:00.000Z', source: 'dom' });
    expect(record.timeLeftText?.confidence).toBe(0.95);
    expect(warnings.some((warning) => warning.startsWith('END_TIME_FROM_TEXT'))).toBe(false);
  });
});

// 2026-09-05 12:57Z + 14:00Z deals fires (site-ebay+extractor_defect+seller-
// login-id-recoverable-from-description-iframe-url): on a store-only seller card
// the extractor raised SELLER_LOGIN_ID_UNAVAILABLE, yet the same page's item-
// description iframe (itm.ebaydesc.com, denied as a subresource but present in
// the DOM as an attribute) carried the login id as its seller= parameter —
// 198591780847: /str/dealsoncisco vs seller=sunthan, verified by an _ssn=sunthan
// search that returned the item itself; 168613737621: /str/cartridgeman07 vs
// seller=cartridge_man07, an id no transformation of the slug yields.
describe('seller login id recovered from the description iframe (2026-09-05)', () => {
  const CAPTURED = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'countdown', 'keyed', 'html');
  const iframe = (itemId: string, seller: string): string =>
    `<iframe id="desc_ifr" title="Seller's description of item" src="https://itm.ebaydesc.com/itmdesc/${itemId}?t=0&category=51268&seller=${seller}&excSoj=1&ver=1&excTrk=1&lsite=2&domain=ebay.com"></iframe>`;

  it('records the iframe seller= as the login id when the card links only a store, and says where it came from', () => {
    const document = parseHTML(
      `<h1 class="x-item-title__mainTitle">Cisco C9300-48P switch</h1>
       <div class="x-price-primary">C $450.00</div>
       <div class="x-sellercard-atf">
         <div class="x-sellercard-atf__info__about-seller">
           <a href="https://www.ebay.ca/str/dealsoncisco"><span>Deals On Cisco</span></a>
         </div>
       </div>
       ${iframe('198591780847', 'sunthan')}`,
    ).document as unknown as Document;
    const { record, warnings } = extractListing(document, 'https://www.ebay.ca/itm/198591780847');
    expect(record.seller).toEqual({ value: 'sunthan', source: 'dom', confidence: 0.9 });
    expect(record.sellerStoreSlug?.value).toBe('dealsoncisco');
    expect(warnings.some((w) => w.startsWith('SELLER_LOGIN_ID_UNAVAILABLE'))).toBe(false);
    const marker = warnings.find((w) => w.startsWith('SELLER_LOGIN_ID_FROM_DESCRIPTION_IFRAME'));
    expect(marker).toMatch(/dealsoncisco/);
    expect(marker).toMatch(/sunthan/);
  });

  it('keeps an underscore login id exactly as the iframe gives it', () => {
    const document = parseHTML(
      `<h1 class="x-item-title__mainTitle">Toner lot</h1>
       <div class="x-price-primary">C $30.00</div>
       <div class="x-sellercard-atf"><a href="https://www.ebay.ca/str/cartridgeman07">Cartridge Man</a></div>
       ${iframe('168613737621', 'cartridge_man07')}`,
    ).document as unknown as Document;
    const { record } = extractListing(document, 'https://www.ebay.ca/itm/168613737621');
    expect(record.seller?.value).toBe('cartridge_man07');
    expect(record.sellerStoreSlug?.value).toBe('cartridgeman07');
  });

  it('never outranks a /usr/ login id on the card, and raises no marker then', () => {
    const document = parseHTML(
      `<h1 class="x-item-title__mainTitle">LEGO lot</h1>
       <div class="x-price-primary">C $25.00</div>
       <div class="x-sellercard-atf"><a href="https://www.ebay.ca/usr/novanut74">novanut74</a></div>
       ${iframe('257679218767', 'someone_else')}`,
    ).document as unknown as Document;
    const { record, warnings } = extractListing(document, 'https://www.ebay.ca/itm/257679218767');
    expect(record.seller).toMatchObject({ value: 'novanut74', confidence: 0.99 });
    expect(warnings.some((w) => w.startsWith('SELLER_LOGIN_ID_FROM_DESCRIPTION_IFRAME'))).toBe(false);
  });

  it('reads only eBay\'s own description host, and only a login-id-shaped value', () => {
    const foreign = parseHTML(
      `<h1 class="x-item-title__mainTitle">Lot</h1><div class="x-price-primary">C $1.00</div>
       <div class="x-sellercard-atf"><a href="https://www.ebay.ca/str/somestore">Store</a></div>
       <iframe id="desc_ifr" src="https://itm.ebaydesc.com.attacker.example/itmdesc/1?seller=evil"></iframe>
       <iframe src="https://itm.ebaydesc.com/itmdesc/1?seller=not%20a%20login%20id%3Cscript%3E"></iframe>`,
    ).document as unknown as Document;
    const { record, warnings } = extractListing(foreign, 'https://www.ebay.ca/itm/100000000001');
    expect(record.seller).toBeNull();
    expect(warnings.some((w) => w.startsWith('SELLER_LOGIN_ID_UNAVAILABLE'))).toBe(true);
  });

  it('resolves the seller on the captured ebay.ca item page whose card links neither /usr/ nor /str/', () => {
    const html = readFileSync(join(CAPTURED, 'ebay-ca-itm-287557851282.html'), 'utf8');
    const document = parseHTML(html).document as unknown as Document;
    const { record, warnings } = extractListing(document, 'https://www.ebay.ca/itm/287557851282');
    expect(record.seller).toEqual({ value: 'bageltremors', source: 'dom', confidence: 0.9 });
    expect(warnings).not.toContain('seller could not be resolved');
    expect(ExtractionRecordSchema.safeParse(record).success).toBe(true);
  });
});
