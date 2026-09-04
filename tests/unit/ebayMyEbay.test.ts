/**
 * My eBay page kinds — the signed-in watch list and the bids/offers page
 * the deals routine's Track W and Track O walk. The fixtures are AUTHORED
 * (no live capture existed when this shipped; see the fixture headers),
 * so these tests pin the contract — classification, the row shape, the
 * three empty-page diagnoses, pagination — rather than eBay's markup. A
 * live capture replaces the fixtures without changing a single assertion
 * about the shape.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  buildOffersUrl,
  buildWatchlistUrl,
  classifyEbayPage,
  extractOffersPage,
  extractWatchlistPage,
} from '@browser-bridge/site-ebay';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ebay');
const OBSERVED_AT = new Date('2026-09-03T22:00:00.000Z');

function loadFixture(name: string): Document {
  return parseHTML(readFileSync(join(FIXTURES, name), 'utf8')).document as unknown as Document;
}

describe('classifyEbayPage knows the My eBay surfaces', () => {
  it('classifies the current and classic watch-list paths', () => {
    expect(classifyEbayPage('https://www.ebay.ca/mye/myebay/watchlist')).toBe('watchlist');
    expect(classifyEbayPage('https://www.ebay.ca/mye/myebay/watchlist?page=2&sort=endingSoonest')).toBe('watchlist');
    expect(classifyEbayPage('https://www.ebay.com/mye/myebay/v2/watchlist')).toBe('watchlist');
    expect(classifyEbayPage('https://www.ebay.ca/myb/WatchList')).toBe('watchlist');
    expect(classifyEbayPage('https://www.ebay.ca/myb/Watch-List/')).toBe('watchlist');
  });

  it('classifies the bids/offers paths, before the watch list when both words appear', () => {
    expect(classifyEbayPage('https://www.ebay.ca/mye/myebay/bidsoffers')).toBe('offers');
    expect(classifyEbayPage('https://www.ebay.com/myb/BidsOffers')).toBe('offers');
    expect(classifyEbayPage('https://www.ebay.ca/mye/myebay/offers')).toBe('offers');
    expect(classifyEbayPage('https://www.ebay.ca/myb/OffersReceived')).toBe('offers');
    expect(classifyEbayPage('https://www.ebay.ca/mye/myebay/bidsoffers?from=watchlist')).toBe('offers');
  });

  it('leaves item, search, store and summary pages where they were', () => {
    expect(classifyEbayPage('https://www.ebay.ca/itm/123456789012')).toBe('listing');
    expect(classifyEbayPage('https://www.ebay.ca/sch/i.html?_nkw=lego')).toBe('search');
    expect(classifyEbayPage('https://www.ebay.ca/usr/brickseller')).toBe('store');
    expect(classifyEbayPage('https://www.ebay.ca/mye/myebay/summary')).toBe('other');
    // A listing whose slug mentions a watch list is still a listing.
    expect(classifyEbayPage('https://www.ebay.ca/itm/vintage-watchlist-book/123456789012')).toBe('listing');
  });

  it('builds the canonical My eBay URLs the routine navigates', () => {
    expect(buildWatchlistUrl()).toBe('https://www.ebay.ca/mye/myebay/watchlist');
    expect(buildWatchlistUrl('ebay.ca', 3)).toBe('https://www.ebay.ca/mye/myebay/watchlist?page=3');
    expect(buildOffersUrl('ebay.com')).toBe('https://www.ebay.com/mye/myebay/bidsoffers');
    expect(classifyEbayPage(buildWatchlistUrl())).toBe('watchlist');
    expect(classifyEbayPage(buildOffersUrl())).toBe('offers');
  });
});

describe('extractWatchlistPage', () => {
  const page = extractWatchlistPage(loadFixture('watchlist-page.html'), 'https://www.ebay.ca/mye/myebay/watchlist', {
    observedAt: OBSERVED_AT,
  });

  it('keys every card on its /itm/ link, in page order, once each', () => {
    expect(page.candidates.map((row) => row.itemId)).toEqual([
      '198589141532',
      '127905836341',
      '115641809410',
      '336429205380',
      '331982822376',
    ]);
    expect(page.candidates.map((row) => row.order)).toEqual([0, 1, 2, 3, 4]);
    expect(page.signedIn).toBe(true);
    expect(page.pageTitle).toBe('Watch list | My eBay');
  });

  it('reads the list count from the "All" tab, not from a card', () => {
    expect(page.totalCount).toBe(312);
    expect(page.totalCountSource).toBe('All (312)');
  });

  it('reads an auction card: bids, countdown, a derived end time, the /usr/ seller', () => {
    const arista = page.candidates[0]!;
    expect(arista.title).toBe('Arista DCS-7050QX-32S-F 32x 40GbE QSFP+ 4x SFP+ Switch Tested');
    expect(arista.snippetPrice).toEqual({ value: 412, currency: 'CAD' });
    expect(arista.sellingFormat).toBe('auction');
    expect(arista.bidCount).toBe(7);
    expect(arista.timeLeftText).toBe('1d 04h 12m left');
    // 1d 4h 12m after 22:00Z on the 3rd.
    expect(arista.endsAt).toBe('2026-09-05T02:12:00.000Z');
    expect(arista.watchlistStatus).toBe('active');
    expect(arista.seller).toBe('netgear_liquidators');
    expect(arista.sellerText).toMatch(/netgear_liquidators \(4,812\) 99\.6%/);
    expect(arista.shippingSnippetText).toBe('+C $38.20 shipping');
    expect(arista.conditionText).toBe('Pre-Owned');
    expect(arista.sellerOffer).toBeNull();
  });

  it('reads a seller-sent offer off the card, with its amount', () => {
    const mellanox = page.candidates[1]!;
    expect(mellanox.snippetPrice).toEqual({ value: 189, currency: 'USD' });
    expect(mellanox.sellingFormat).toBe('fixed_price');
    expect(mellanox.sellerOffer).not.toBeNull();
    expect(mellanox.sellerOffer!.price).toEqual({ value: 165, currency: 'USD' });
    expect(mellanox.sellerOffer!.text).toMatch(/^Seller sent you an offer: US \$165\.00/);
    expect(mellanox.seller).toBe('serverpartsdepot');
  });

  it('reads a price-drop badge and free shipping on a fixed-price card without a /usr/ link', () => {
    const drive = page.candidates[2]!;
    expect(drive.priceDropText).toBe('Price drop: was US $1,299.00');
    expect(drive.snippetPrice).toEqual({ value: 1149, currency: 'USD' });
    expect(drive.shippingSnippetText).toBe('Free shipping');
    expect(drive.seller).toBeNull();
    expect(drive.sellerText).toMatch(/tapeworks_usa \(883\) 100%/);
    expect(drive.watchlistStatus).toBe('active');
  });

  it('marks an ended card ended and keeps its last price as evidence', () => {
    const tapes = page.candidates[3]!;
    expect(tapes.watchlistStatus).toBe('ended');
    expect(tapes.snippetPrice).toEqual({ value: 255, currency: 'USD' });
    expect(tapes.timeLeftText).toBeNull();
    expect(tapes.endsAt).toBeNull();
  });

  it('strips the New Listing badge from a title and flags it', () => {
    const tiles = page.candidates[4]!;
    expect(tiles.title).toBe('Assorted Genuine LEGO Printed/Decorated Tiles');
    expect(tiles.isNewListing).toBe(true);
    expect(tiles.shippingSnippetText).toBe('Shipping not specified');
  });

  it('follows the site pagination and reports the current page', () => {
    expect(page.hasNextPage).toBe(true);
    expect(page.nextPageUrl).toBe('https://www.ebay.ca/mye/myebay/watchlist?page=2');
    expect(page.currentPage).toBeNull();
    expect(page.warnings).toEqual([]);
  });

  it('diagnoses a sign-in wall instead of reporting an empty list', () => {
    const wall = extractWatchlistPage(loadFixture('watchlist-signin.html'), 'https://www.ebay.ca/mye/myebay/watchlist');
    expect(wall.candidates).toEqual([]);
    expect(wall.signedIn).toBe(false);
    expect(wall.warnings).toHaveLength(1);
    expect(wall.warnings[0]).toMatch(/^SIGN_IN_REQUIRED/);
    expect(wall.warnings[0]).toMatch(/never through the bridge/);
  });

  it('says when it cannot tell an empty list from an unrecognised template', () => {
    const { document } = parseHTML('<html><head><title>Watch list | My eBay</title></head><body><main><h1>Watch list</h1></main></body></html>');
    const blank = extractWatchlistPage(document as unknown as Document, 'https://www.ebay.ca/mye/myebay/watchlist');
    expect(blank.signedIn).toBeNull();
    expect(blank.totalCount).toBeNull();
    expect(blank.warnings).toHaveLength(1);
    expect(blank.warnings[0]).toMatch(/^WATCHLIST_NO_CANDIDATES/);
    expect(blank.warnings[0]).toMatch(/browser_snapshot/);
  });

  it('names an unread remainder when the stated count exceeds the rows and no next control renders', () => {
    const { document } = parseHTML(`
      <html><head><title>Watch list | My eBay</title></head><body>
      <div role="tablist"><button role="tab">All (40)</button></div>
      <div class="m-item"><a class="m-item__title" href="https://www.ebay.ca/itm/123456789012">Only row</a><div class="m-item__price">C $5.00</div></div>
      </body></html>`);
    const partial = extractWatchlistPage(document as unknown as Document, 'https://www.ebay.ca/mye/myebay/watchlist?page=2');
    expect(partial.candidates).toHaveLength(1);
    expect(partial.totalCount).toBe(40);
    expect(partial.currentPage).toBe(2);
    expect(partial.hasNextPage).toBe(false);
    const unknown = partial.warnings.find((warning) => warning.startsWith('WATCHLIST_PAGINATION_UNKNOWN'));
    expect(unknown).toBeDefined();
    expect(unknown).toMatch(/page=3/);
  });

  it('derives the next URL from a client-side next button and says it did', () => {
    const { document } = parseHTML(`
      <html><head><title>Watch list | My eBay</title></head><body>
      <div class="m-item"><a class="m-item__title" href="https://www.ebay.ca/itm/123456789012">Row</a><div class="m-item__price">C $5.00</div></div>
      <nav class="pagination"><button class="pagination__next" aria-label="Next page">Next</button></nav>
      </body></html>`);
    const derived = extractWatchlistPage(document as unknown as Document, 'https://www.ebay.ca/mye/myebay/watchlist');
    expect(derived.hasNextPage).toBe(true);
    expect(derived.nextPageUrl).toBe('https://www.ebay.ca/mye/myebay/watchlist?page=2');
    expect(derived.warnings.some((warning) => warning.startsWith('WATCHLIST_NEXT_URL_DERIVED'))).toBe(true);
  });

  it('treats a disabled next control as the last page', () => {
    const { document } = parseHTML(`
      <html><head><title>Watch list | My eBay</title></head><body>
      <div class="m-item"><a class="m-item__title" href="https://www.ebay.ca/itm/123456789012">Row</a><div class="m-item__price">C $5.00</div></div>
      <nav class="pagination"><a class="pagination__next" rel="next" aria-disabled="true" href="#">Next</a></nav>
      </body></html>`);
    const last = extractWatchlistPage(document as unknown as Document, 'https://www.ebay.ca/mye/myebay/watchlist?page=8');
    expect(last.hasNextPage).toBe(false);
    expect(last.nextPageUrl).toBeNull();
  });

  it('reports the fields no row could read, so partial enrichment is visible', () => {
    const { document } = parseHTML(`
      <html><head><title>Watch list | My eBay</title></head><body>
      <div><a href="https://www.ebay.ca/itm/123456789012">Bare row</a></div>
      <div><a href="https://www.ebay.ca/itm/123456789013">Other bare row</a></div>
      </body></html>`);
    const bare = extractWatchlistPage(document as unknown as Document, 'https://www.ebay.ca/mye/myebay/watchlist');
    expect(bare.candidates).toHaveLength(2);
    const nulls = bare.warnings.find((warning) => warning.startsWith('WATCHLIST_FIELDS_NULL'));
    expect(nulls).toMatch(/snippetPrice on all 2/);
    expect(nulls).toMatch(/seller on all 2/);
    expect(bare.candidates[0]!.watchlistStatus).toBe('unknown');
  });
});

describe('extractOffersPage', () => {
  const page = extractOffersPage(loadFixture('offers-page.html'), 'https://www.ebay.ca/mye/myebay/bidsoffers', {
    observedAt: OBSERVED_AT,
  });

  it('returns one row per offer with the item identity', () => {
    expect(page.candidates.map((row) => row.itemId)).toEqual(['127905836341', '115641809410', '331982822376']);
    expect(page.signedIn).toBe(true);
    expect(page.pageTitle).toBe('Bids and offers | My eBay');
    expect(page.hasNextPage).toBe(false);
  });

  it('reads a seller-sent offer: amount, list price, open status, expiry and the seller', () => {
    const offer = page.candidates[0]!;
    expect(offer.direction).toBe('from_seller');
    expect(offer.offerPrice).toEqual({ value: 165, currency: 'USD' });
    expect(offer.listPrice).toEqual({ value: 189, currency: 'USD' });
    expect(offer.offerStatus).toBe('open');
    expect(offer.expiresText).toBe('Expires in 1d 22h');
    expect(offer.expiresAt).toBe('2026-09-05T20:00:00.000Z');
    expect(offer.seller).toBe('serverpartsdepot');
    expect(offer.snippet).toMatch(/Seller sent you an offer/);
  });

  it('reads an offer the operator made and its declined state', () => {
    const mine = page.candidates[1]!;
    expect(mine.direction).toBe('from_you');
    expect(mine.offerPrice).toEqual({ value: 950, currency: 'USD' });
    expect(mine.listPrice).toEqual({ value: 1149, currency: 'USD' });
    expect(mine.offerStatus).toBe('declined');
    expect(mine.expiresText).toBeNull();
    expect(mine.seller).toBeNull();
    expect(mine.sellerText).toMatch(/tapeworks_usa/);
  });

  it('reads a seller counteroffer that has expired', () => {
    const counter = page.candidates[2]!;
    expect(counter.direction).toBe('from_seller');
    expect(counter.offerPrice).toEqual({ value: 2.75, currency: 'CAD' });
    expect(counter.listPrice).toBeNull();
    expect(counter.offerStatus).toBe('expired');
  });

  it('emits no warning when every row classified', () => {
    expect(page.warnings).toEqual([]);
  });

  it('diagnoses a sign-in wall and an empty page separately', () => {
    const wall = extractOffersPage(loadFixture('watchlist-signin.html'), 'https://www.ebay.ca/mye/myebay/bidsoffers');
    expect(wall.candidates).toEqual([]);
    expect(wall.signedIn).toBe(false);
    expect(wall.warnings[0]).toMatch(/^SIGN_IN_REQUIRED/);

    const { document } = parseHTML('<html><head><title>Bids and offers | My eBay</title></head><body><h1>Bids and offers</h1></body></html>');
    const empty = extractOffersPage(document as unknown as Document, 'https://www.ebay.ca/mye/myebay/bidsoffers');
    expect(empty.signedIn).toBeNull();
    expect(empty.warnings[0]).toMatch(/^OFFERS_NO_ROWS/);
  });

  it('keeps a row whose direction it cannot tell and says so', () => {
    const { document } = parseHTML(`
      <html><head><title>Bids and offers | My eBay</title></head><body>
      <div class="offer-card"><a href="https://www.ebay.ca/itm/123456789012">Some lot</a><div>Offer: C $12.00 · Pending</div></div>
      </body></html>`);
    const vague = extractOffersPage(document as unknown as Document, 'https://www.ebay.ca/mye/myebay/bidsoffers');
    expect(vague.candidates).toHaveLength(1);
    expect(vague.candidates[0]!.direction).toBe('unknown');
    expect(vague.candidates[0]!.offerPrice).toEqual({ value: 12, currency: 'CAD' });
    expect(vague.candidates[0]!.offerStatus).toBe('open');
    expect(vague.warnings.some((warning) => warning.startsWith('OFFERS_DIRECTION_UNKNOWN'))).toBe(true);
  });
});
