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
    // A price alone no longer implies a live listing: on the 2026-09-04
    // overflow render 81 of 118 priced, unbadged cards had ended.
    expect(drive.watchlistStatus).toBe('unknown');
    expect(drive.sellingFormat).toBe('unknown');
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
    // Two of the five authored cards state neither a status nor a format;
    // the page says so instead of defaulting them.
    expect(page.warnings.map((warning) => warning.split(':')[0])).toEqual(['WATCHLIST_STATUS_UNSTATED', 'WATCHLIST_FORMAT_UNSTATED']);
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

// 2026-09-04 deals fires (site-ebay+extractor_defect+offers-template-unpinned,
// offers-offerprice-is-the-ask-not-a-received-offer, offers-page-underreads-
// stated-row-count): on the live /mye/myebay/bidsoffers page every row read
// offerPrice HIGHER than listPrice, and opening two rows' item pages proved
// offerPrice == the listing's own ask (800300142565: offerPrice 65 CAD,
// itemPrice 65.00 CAD). The rows carry the listing's Best Offer control
// ("Make Best offer") followed by the ask, which the offer-amount regex read
// as an offer. Rows that DO hold a thread say "View offer details" and
// render no amount. The page's own header says "All (39)" over 31 rows.
describe('offers page: the Best Offer control is not an offer (2026-09-04 fires)', () => {
  function offersDoc(rows: string): Document {
    const { document } = parseHTML(
      `<html><head><title>Bids and offers | My eBay</title></head><body>
       <div class="filter-menu" role="tablist"><button role="tab" aria-selected="true">All (39)</button><button role="tab">Offers (31)</button></div>
       <ul>${rows}</ul></body></html>`,
    );
    return document as unknown as Document;
  }
  const control = `<li class="offer-card"><a href="https://www.ebay.ca/itm/800300142565">Cisco C9130AXE-A Access Point</a>
      <div class="offer-card__info">Buy It Now C $65.00 +C $19.99 shipping</div><button>Make Best offer</button></li>`;
  const thread = `<li class="offer-card"><a href="https://www.ebay.ca/itm/358700472944">Arista DCS-7050QX-32S</a>
      <div class="offer-card__info">C $890.00</div><a href="https://www.ebay.ca/mye/myebay/bidsoffers?offer=1">View offer details</a></li>`;

  it('never reads the ask after "Make Best offer" as an offer amount', () => {
    const page = extractOffersPage(offersDoc(control), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    const row = page.candidates[0]!;
    expect(row.offerPrice).toBeNull();
    expect(row.listPrice).toEqual({ value: 65, currency: 'CAD' });
    expect(row.direction).toBe('unknown');
    expect(row.offerStatus).toBe('none');
    const none = page.warnings.find((warning) => warning.startsWith('OFFERS_NO_OFFER_THREAD'));
    expect(none).toBeDefined();
    expect(none).toMatch(/1 of 1/);
  });

  it('reports a row that holds a thread whose figures the template does not render', () => {
    const page = extractOffersPage(offersDoc(thread), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    const row = page.candidates[0]!;
    expect(row.offerPrice).toBeNull();
    expect(row.offerStatus).toBe('unknown');
    const unread = page.warnings.find((warning) => warning.startsWith('OFFERS_THREAD_UNREAD'));
    expect(unread).toBeDefined();
    expect(unread).toMatch(/358700472944/);
    expect(unread).toMatch(/offers-template-unpinned/);
  });

  it('reads the stated row count from the "All" tab and names the shortfall', () => {
    const page = extractOffersPage(offersDoc(control + thread), 'https://www.ebay.ca/mye/myebay/bidsoffers', {
      observedAt: OBSERVED_AT,
    });
    expect(page.totalCount).toBe(39);
    expect(page.totalCountSource).toBe('All (39)');
    const short = page.warnings.find((warning) => warning.startsWith('OFFERS_PAGINATION_UNKNOWN'));
    expect(short).toBeDefined();
    expect(short).toMatch(/39/);
    expect(short).toMatch(/\b2\b/);
  });

  it('still reads a labelled offer amount when the row carries one', () => {
    const page = extractOffersPage(loadFixture('offers-page.html'), 'https://www.ebay.ca/mye/myebay/bidsoffers', {
      observedAt: OBSERVED_AT,
    });
    expect(page.candidates[0]!.offerPrice).toEqual({ value: 165, currency: 'USD' });
    expect(page.totalCount).toBe(3);
    expect(page.warnings).toEqual([]);
  });
});

// 2026-09-04 deals fire (site-ebay+extractor_defect+watchlist-totalresults-
// misparse-as-1): every one of 34 watch-list reads reported totalResults 1
// from totalCountSource "1 item" while the page rendered up to 328 rows.
describe('watch list: a stated count below the rendered rows is rejected (2026-09-04 fire)', () => {
  function watchlistDoc(countLabel: string, rows = 3): Document {
    const cards = Array.from(
      { length: rows },
      (_, index) =>
        `<li class="m-item"><a class="m-item__title" href="https://www.ebay.ca/itm/28713881074${index}">Item ${index}</a><div class="m-item__price">C $${10 + index}.00</div></li>`,
    ).join('');
    const { document } = parseHTML(
      `<html><head><title>Watch list | My eBay</title></head><body>${countLabel}<ul>${cards}</ul></body></html>`,
    );
    return document as unknown as Document;
  }

  it('drops a "1 item" label read as the list total when three rows rendered, and says so', () => {
    const page = extractWatchlistPage(watchlistDoc('<h2>1 item</h2>'), 'https://www.ebay.ca/mye/myebay/watchlist', {
      observedAt: OBSERVED_AT,
    });
    expect(page.candidates).toHaveLength(3);
    expect(page.totalCount).toBeNull();
    expect(page.totalCountSource).toBeNull();
    const rejected = page.warnings.find((warning) => warning.startsWith('WATCHLIST_TOTAL_REJECTED'));
    expect(rejected).toBeDefined();
    expect(rejected).toMatch(/"1 item"/);
    expect(rejected).toMatch(/3 rows/);
  });

  it('prefers the "All (N)" tab over an "N items" heading when both render', () => {
    const page = extractWatchlistPage(
      watchlistDoc('<div role="tablist"><button role="tab">All (312)</button></div><h2>1 item</h2>'),
      'https://www.ebay.ca/mye/myebay/watchlist',
      { observedAt: OBSERVED_AT },
    );
    expect(page.totalCount).toBe(312);
    expect(page.totalCountSource).toBe('All (312)');
  });
});

// 2026-09-04 20:00Z deals fire (site-ebay+extractor_defect+offers-listprice-
// is-the-offer-and-direction-is-in-the-snippet-prefix): on the live
// /mye/myebay/bidsoffers page every row's snippet began with an uppercase
// status token — "OFFER RECEIVED" on the 6 open rows, "OFFER EXPIRED" on 19 —
// and the two figures a row carries were read the wrong way round: offerPrice
// held the ask and listPrice the seller's offer (267676402924: offerPrice
// C $84.99 / listPrice C $72.24, item page ask C $84.99; 168360507031 and
// 128028063251 the same; listPrice below offerPrice on all 25 rows carrying
// both). The 6 rows with no offer prefix and "Your max bid:" are the
// operator's own auction bids. NO live row markup is captured: the layout
// below is the one consistent with the fire's field-level output (an
// unlabelled offer figure, then a "Make offer" control beside the ask),
// and the fix is layout-agnostic — the prefix is read off the snippet and an
// offer is never the higher of a row's two figures.
describe('offers page: the status prefix and the ordering of the two figures (2026-09-04 20:00Z fire)', () => {
  function offersDoc(rows: string): Document {
    const { document } = parseHTML(
      `<html><head><title>Bids and offers | My eBay</title></head><body>
       <div class="filter-menu" role="tablist"><button role="tab" aria-selected="true">All (31)</button></div>
       <ul>${rows}</ul></body></html>`,
    );
    return document as unknown as Document;
  }
  const received = `<li class="offer-card"><span class="eyebrow">OFFER RECEIVED</span>
      <a href="https://www.ebay.ca/itm/267676402924">LEGO Star Wars 75192 Millennium Falcon manual</a>
      <div><span>C $72.24</span></div><div>Buy It Now C $84.99 <button>Make offer</button></div></li>`;
  const expired = `<li class="offer-card"><span class="eyebrow">OFFER EXPIRED</span>
      <a href="https://www.ebay.ca/itm/267759834239">LEGO minifigure lot</a>
      <div><span>C $10.00</span></div><div>C $12.50 <button>Make offer</button></div></li>`;
  const bid = `<li class="offer-card"><a href="https://www.ebay.ca/itm/366630546269">Arista DCS-7050QX-32S</a>
      <div>12 bids · Your max bid: US $41.00</div></li>`;

  it('reads OFFER RECEIVED as an open offer from the seller, offer below ask', () => {
    const page = extractOffersPage(offersDoc(received), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    const row = page.candidates[0]!;
    expect(row.direction).toBe('from_seller');
    expect(row.offerStatus).toBe('open');
    expect(row.offerPrice).toEqual({ value: 72.24, currency: 'CAD' });
    expect(row.listPrice).toEqual({ value: 84.99, currency: 'CAD' });
    expect(page.warnings.some((warning) => warning.startsWith('OFFERS_DIRECTION_UNKNOWN'))).toBe(false);
    expect(page.warnings.some((warning) => warning.startsWith('OFFERS_NO_OFFER_THREAD'))).toBe(false);
  });

  it('reads OFFER EXPIRED as an expired seller offer with both figures in order', () => {
    const page = extractOffersPage(offersDoc(expired), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    const row = page.candidates[0]!;
    expect(row.direction).toBe('from_seller');
    expect(row.offerStatus).toBe('expired');
    expect(row.offerPrice).toEqual({ value: 10, currency: 'CAD' });
    expect(row.listPrice).toEqual({ value: 12.5, currency: 'CAD' });
  });

  it('names the rows whose labelled figure was the higher one, and says which way they were read', () => {
    const page = extractOffersPage(offersDoc(received + expired), 'https://www.ebay.ca/mye/myebay/bidsoffers', {
      observedAt: OBSERVED_AT,
    });
    const ordered = page.warnings.find((warning) => warning.startsWith('OFFERS_AMOUNTS_ORDERED_BY_VALUE'));
    expect(ordered).toBeDefined();
    expect(ordered).toMatch(/2 of 2/);
    expect(ordered).toMatch(/never above the ask/);
  });

  it('keeps a labelled offer that is already the lower figure exactly as labelled, with no ordering note', () => {
    const page = extractOffersPage(loadFixture('offers-page.html'), 'https://www.ebay.ca/mye/myebay/bidsoffers', {
      observedAt: OBSERVED_AT,
    });
    expect(page.candidates[0]!.offerPrice).toEqual({ value: 165, currency: 'USD' });
    expect(page.candidates[0]!.listPrice).toEqual({ value: 189, currency: 'USD' });
    expect(page.warnings).toEqual([]);
  });

  it('a "Your max bid" row with no offer prefix is the operator\'s own bid: from_you, no offer, not an unknown', () => {
    const page = extractOffersPage(offersDoc(bid + received), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    const row = page.candidates[0]!;
    expect(row.itemId).toBe('366630546269');
    expect(row.direction).toBe('from_you');
    expect(row.offerStatus).toBe('none');
    expect(row.offerPrice).toBeNull();
    expect(page.warnings.some((warning) => warning.startsWith('OFFERS_DIRECTION_UNKNOWN'))).toBe(false);
    expect(page.warnings.some((warning) => warning.startsWith('OFFERS_NO_OFFER_THREAD'))).toBe(false);
    const bids = page.warnings.find((warning) => warning.startsWith('OFFERS_BID_ROWS'));
    expect(bids).toBeDefined();
    expect(bids).toMatch(/1 of 2/);
    expect(bids).toMatch(/366630546269/);
  });

  it('still reads "you offered" wording as the operator\'s own offer when the prefix says only EXPIRED', () => {
    const own = `<li class="offer-card"><span class="eyebrow">OFFER EXPIRED</span>
      <a href="https://www.ebay.ca/itm/115641809410">IBM LTO-8 drive</a>
      <div>You offered US $950.00</div><div>US $1,149.00</div></li>`;
    const page = extractOffersPage(offersDoc(own), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    expect(page.candidates[0]!.direction).toBe('from_you');
    expect(page.candidates[0]!.offerStatus).toBe('expired');
    expect(page.candidates[0]!.offerPrice).toEqual({ value: 950, currency: 'USD' });
  });
});

// 2026-09-04 20:00Z deals fire (site-ebay+extractor_defect+watchlist-overflow-
// render-status-format-and-price-unreliable): the ?page=99 overflow render of
// a 346-row watch list carried no status badge, no format element and no
// countdown on its cards, and the reader filled the gaps with inferences —
// watchlistStatus 'active' on 343 rows of which 81 of the 118 validated had
// ended; sellingFormat 'fixed_price' on all 346 including 44 live auctions
// with bids; and 137295398934 read 'sold' from its "N sold" quantity badge
// while its item page was live at C $35.00. A walk that trusted the cards
// produced 95 phantom change events. A card that states nothing gets an
// 'unknown', and the page says how many rows that was.
describe('watch list: an overflow card that states no status or format gets unknown, never a default (2026-09-04 20:00Z fire)', () => {
  function watchlistDoc(cards: string): Document {
    const { document } = parseHTML(
      `<html><head><title>Watch list | My eBay</title></head><body>
       <div class="filter-menu" role="tablist"><button role="tab" aria-selected="true">All (346)</button></div>
       <ul>${cards}</ul></body></html>`,
    );
    return document as unknown as Document;
  }
  const endedButUnbadged = `<li class="m-item"><a class="m-item__title" href="https://www.ebay.ca/itm/178459747470">Cisco C9130AXE-A</a>
      <div class="m-item__price">C $45.00</div> <div>Seller: lapennaco (12,004) 99.9%</div></li>`;
  const auctionUnbadged = `<li class="m-item"><a class="m-item__title" href="https://www.ebay.ca/itm/137605605739">Arista DCS-7050QX-32S</a>
      <div class="m-item__price">C $412.00</div></li>`;
  const soldCount = `<li class="m-item"><a class="m-item__title" href="https://www.ebay.ca/itm/137295398934">Genuine LEGO plates lot</a>
      <div class="m-item__price">C $35.00</div> <div class="m-item__hotness">12 sold</div></li>`;
  const countdown = `<li class="m-item"><a class="m-item__title" href="https://www.ebay.ca/itm/318689537241">IBM TS2900</a>
      <div class="m-item__price">C $770.65</div> <div>2d 3h left</div></li>`;
  const stated = `<li class="m-item"><a class="m-item__title" href="https://www.ebay.ca/itm/127905836341">Mellanox SX1012</a>
      <div class="m-item__price">US $189.00</div> <div>Buy It Now or Best Offer</div></li>`;
  const page = extractWatchlistPage(watchlistDoc(endedButUnbadged + auctionUnbadged + soldCount + countdown + stated), 'https://www.ebay.ca/mye/myebay/watchlist?page=99', {
    observedAt: OBSERVED_AT,
  });
  const byId = (id: string) => page.candidates.find((row) => row.itemId === id)!;

  it('a priced card with no badge and no countdown is unknown, not active', () => {
    expect(byId('178459747470').watchlistStatus).toBe('unknown');
    expect(byId('137605605739').watchlistStatus).toBe('unknown');
  });

  it('a card that states neither bids nor Buy It Now has an unknown format, not fixed_price', () => {
    expect(byId('178459747470').sellingFormat).toBe('unknown');
    expect(byId('137605605739').sellingFormat).toBe('unknown');
    expect(byId('137605605739').bidCount).toBeNull();
  });

  it('"12 sold" is a quantity badge, not a sold state', () => {
    expect(byId('137295398934').watchlistStatus).toBe('unknown');
  });

  it('a countdown is still the one card-level tell of a live listing', () => {
    expect(byId('318689537241').watchlistStatus).toBe('active');
    expect(byId('318689537241').timeLeftText).toBe('2d 3h left');
  });

  it('a card that states Buy It Now keeps its format', () => {
    expect(byId('127905836341').sellingFormat).toBe('fixed_price');
  });

  it('the page counts the rows whose status and format it could not read, so a walk never diffs from them', () => {
    const status = page.warnings.find((warning) => warning.startsWith('WATCHLIST_STATUS_UNSTATED'));
    expect(status).toBeDefined();
    expect(status).toMatch(/4 of 5/);
    expect(status).toMatch(/item page/);
    const format = page.warnings.find((warning) => warning.startsWith('WATCHLIST_FORMAT_UNSTATED'));
    expect(format).toBeDefined();
    expect(format).toMatch(/4 of 5/);
  });

  it('the badged fixture still reads its ended and sold states from their wording', () => {
    const fixture = extractWatchlistPage(loadFixture('watchlist-page.html'), 'https://www.ebay.ca/mye/myebay/watchlist', {
      observedAt: OBSERVED_AT,
    });
    expect(fixture.candidates[3]!.watchlistStatus).toBe('ended');
    expect(fixture.candidates[0]!.watchlistStatus).toBe('active');
  });
});

// 2026-09-05 12:52Z deals fire (windows-agent+connector_defect+offers-page-
// fixes-absent-while-watchlist-and-kijiji-fixes-are-live): on the agent build
// that raised WATCHLIST_STATUS_UNSTATED and LISTINGS_NOT_HYDRATED — so mcp-ebay#49
// was deployed — the offers page still read direction 'unknown' on 31 of 31
// rows, no OFFERS_BID_ROWS on the six "Your max bid" rows, and offerPrice above
// listPrice on all 25 two-figure rows, although every snippet began with its
// status token. The synthetic rows #49 was built from separated the eyebrow
// from the title with a newline; the live template's adjacent elements
// concatenate with no whitespace in textContent ("OFFER RECEIVEDLEGO …",
// "12 bidsYour max bid: …"), and a \b-anchored token never matches a title
// that runs straight on from it.
describe('offers page: the status token and the bid label with no whitespace after them (2026-09-05 12:52Z fire)', () => {
  function offersDoc(rows: string): Document {
    const { document } = parseHTML(
      `<html><head><title>Bids and offers | My eBay</title></head><body>` +
        `<div class="filter-menu" role="tablist"><button role="tab" aria-selected="true">All (31)</button></div>` +
        `<ul>${rows}</ul></body></html>`,
    );
    return document as unknown as Document;
  }
  // No whitespace anywhere between the elements: exactly how textContent reads the live row.
  const received =
    `<li class="offer-card"><span class="eyebrow">OFFER RECEIVED</span>` +
    `<a href="https://www.ebay.ca/itm/267676402924">LEGO Star Wars 75192 Millennium Falcon manual</a>` +
    `<div><span>C $72.24</span></div><div><span>C $84.99</span><button>Make offer</button></div></li>`;
  const expired =
    `<li class="offer-card"><span class="eyebrow">OFFER EXPIRED</span>` +
    `<a href="https://www.ebay.ca/itm/168360507031">Arista DCS-7050QX-32S 32-port 40GbE</a>` +
    `<div><span>C $10.00</span></div><div><span>C $12.50</span><button>Make offer</button></div></li>`;
  const bid =
    `<li class="offer-card"><a href="https://www.ebay.ca/itm/366630546269">IBM TS2900 tape autoloader</a>` +
    `<div><span>12 bids</span><span>Your max bid: US $41.00</span></div></li>`;

  it('reads OFFER RECEIVED when the title runs straight on from the token', () => {
    const page = extractOffersPage(offersDoc(received), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    const row = page.candidates[0]!;
    expect(row.snippet.startsWith('OFFER RECEIVEDLEGO')).toBe(true);
    expect(row.direction).toBe('from_seller');
    expect(row.offerStatus).toBe('open');
    expect(row.offerPrice).toEqual({ value: 72.24, currency: 'CAD' });
    expect(row.listPrice).toEqual({ value: 84.99, currency: 'CAD' });
  });

  it('reads OFFER EXPIRED the same way, with both figures in order', () => {
    const page = extractOffersPage(offersDoc(expired), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    const row = page.candidates[0]!;
    expect(row.direction).toBe('from_seller');
    expect(row.offerStatus).toBe('expired');
    expect(row.offerPrice).toEqual({ value: 10, currency: 'CAD' });
    expect(row.listPrice).toEqual({ value: 12.5, currency: 'CAD' });
  });

  it('reads "Your max bid" as the operator\'s own bid when it runs on from the bid count', () => {
    const page = extractOffersPage(offersDoc(bid), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    const row = page.candidates[0]!;
    expect(row.snippet).toContain('12 bidsYour max bid');
    expect(row.direction).toBe('from_you');
    expect(row.offerStatus).toBe('none');
    expect(row.offerPrice).toBeNull();
    expect(page.warnings.find((warning) => warning.startsWith('OFFERS_BID_ROWS'))).toMatch(/366630546269/);
  });

  it('classifies every row of the concatenated template, so the page raises no OFFERS_DIRECTION_UNKNOWN', () => {
    const page = extractOffersPage(offersDoc(received + expired + bid), 'https://www.ebay.ca/mye/myebay/bidsoffers', {
      observedAt: OBSERVED_AT,
    });
    expect(page.candidates.map((row) => row.direction)).toEqual(['from_seller', 'from_seller', 'from_you']);
    expect(page.warnings.some((warning) => warning.startsWith('OFFERS_DIRECTION_UNKNOWN'))).toBe(false);
    expect(page.warnings.find((warning) => warning.startsWith('OFFERS_AMOUNTS_ORDERED_BY_VALUE'))).toMatch(/2 of 3/);
    expect(page.warnings.find((warning) => warning.startsWith('OFFERS_BID_ROWS'))).toMatch(/1 of 3/);
  });

  it('still reads only a token at the head of the row: a title that merely contains the words is not a prefix', () => {
    const titled =
      `<li class="offer-card"><a href="https://www.ebay.ca/itm/115641809410">Special offer received well by collectors</a>` +
      `<div><span>C $20.00</span><button>Make offer</button></div></li>`;
    const page = extractOffersPage(offersDoc(titled), 'https://www.ebay.ca/mye/myebay/bidsoffers', { observedAt: OBSERVED_AT });
    const row = page.candidates[0]!;
    expect(row.direction).toBe('unknown');
    expect(row.offerStatus).toBe('none');
  });
});

// 2026-09-05 15:30Z deals fire (site-ebay+extractor_defect+watchlist-template-
// unpinned): the first browser_snapshot of the live /mye/myebay/watchlist.
// The fixture watchlist-page-2026-09-05.html is authored from that snapshot's
// node order (see its header), with no known card class on any row. What the
// fire reported, and what the fixture reproduces: the page opens with a
// carousel of category-filter link chips ("Drives, Storage & Blank Media
// (1)", accessible name ending ", 1 item") whose counts are per category, and
// the extractor read the first chip's "1 item" as the list total and then
// rejected it (WATCHLIST_TOTAL_REJECTED over 10+ rows); every row read
// sellingFormat unknown although its action link says "Bid Now" or "Buy It
// Now"; sellerText was null on every row although the login id renders
// twice (the /usr/ link "<loginId> username" and the feedback link "100%
// (283) Feedback score is 283 for <loginId>"); the shipping line is a plain
// "+C $38.80 Shipping" text node; and a row converted from a foreign
// currency carries "* Converted from GBP 16.00" beside eBay's C$ figure.
describe('watch list: the 2026-09-05 live template (2026-09-05 15:30Z fire, watchlist-template-unpinned)', () => {
  const page = extractWatchlistPage(loadFixture('watchlist-page-2026-09-05.html'), 'https://www.ebay.ca/mye/myebay/watchlist', {
    observedAt: OBSERVED_AT,
  });
  const byId = (id: string) => page.candidates.find((row) => row.itemId === id)!;
  const codes = () => page.warnings.map((warning) => warning.split(':')[0]);

  it('finds every row once, in page order, through the generic card climb', () => {
    expect(page.candidates.map((row) => row.itemId)).toEqual(['377449134404', '315012183531', '226934512873', '146872203419']);
    expect(page.candidates.map((row) => row.order)).toEqual([0, 1, 2, 3]);
    expect(page.signedIn).toBe(true);
    expect(byId('377449134404').title).toBe('IBM LTO-8 HH SAS Tape Drive 3573-8547 for TS3100 TS3200 Tested');
    expect(byId('315012183531').title).toBe('Arista DCS-7050QX-32S-F 32x 40GbE QSFP+ 4x SFP+ Switch');
  });

  // The 18:21Z deals fire's second snapshot corrected the 15:30Z one: the
  // carousel's HEAD is a selected "All Categories (352) - Selected" chip
  // (href with no filter=, accessible name "…All Categories, 352 items,
  // selected") and it carries the whole-list count. A per-category chip's
  // "(1)" is still never the total.
  it('reads the list total from the selected All Categories chip, never from a per-category chip, and says nothing is unstated', () => {
    expect(page.totalCount).toBe(352);
    expect(page.totalCountSource).toBe('All Categories (352) - Selected');
    expect(codes()).not.toContain('WATCHLIST_TOTAL_REJECTED');
    expect(codes()).not.toContain('WATCHLIST_TOTAL_UNSTATED');
  });

  it('with the All Categories chip absent, the per-category chips are still never the total and the page says it is unstated', () => {
    const { document } = parseHTML(
      readFileSync(join(FIXTURES, 'watchlist-page-2026-09-05.html'), 'utf8').replace(/<a href="https:\/\/www\.ebay\.ca\/myb\/Watchlist\?custom_list_id=WATCH_LIST" aria-label="Filter Watchlist by category: All Categories[^]*?<\/a>/, ''),
    );
    const headless = extractWatchlistPage(document as unknown as Document, 'https://www.ebay.ca/mye/myebay/watchlist', { observedAt: OBSERVED_AT });
    expect(headless.candidates).toHaveLength(4);
    expect(headless.totalCount).toBeNull();
    expect(headless.totalCountSource).toBeNull();
    const heads = headless.warnings.map((warning) => warning.split(':')[0]);
    expect(heads).not.toContain('WATCHLIST_TOTAL_REJECTED');
    const unstated = headless.warnings.find((warning) => warning.startsWith('WATCHLIST_TOTAL_UNSTATED'));
    expect(unstated).toBeDefined();
    expect(unstated).toMatch(/category-filter chips/i);
    expect(unstated).toMatch(/per-category/i);
    expect(unstated).toMatch(/no list total/i);
  });

  it('reads the format from the action link: "Bid Now" is an auction, "Buy It Now" fixed price, so no format is unstated', () => {
    expect(byId('377449134404').sellingFormat).toBe('auction');
    expect(byId('226934512873').sellingFormat).toBe('auction');
    expect(byId('315012183531').sellingFormat).toBe('fixed_price');
    expect(byId('146872203419').sellingFormat).toBe('fixed_price');
    expect(codes()).not.toContain('WATCHLIST_FORMAT_UNSTATED');
  });

  it('reads the seller from the /usr/ link and a bounded sellerText from the two seller links on every row', () => {
    expect(page.candidates.map((row) => row.seller)).toEqual(['tapeworks_uk', 'netgear_liquidators', 'mediahub_direct', 'serverpartsdepot']);
    for (const row of page.candidates) {
      expect(row.sellerText).not.toBeNull();
      expect(row.sellerText!.length).toBeLessThanOrEqual(96);
      expect(row.sellerText).toContain(row.seller!);
    }
    expect(byId('377449134404').sellerText).toMatch(/100% \(283\)/);
    expect(byId('377449134404').sellerText).not.toMatch(/\busername\b/);
    expect(byId('377449134404').sellerText).not.toMatch(/Feedback score/);
    expect(byId('315012183531').sellerText).toMatch(/99\.6% \(4812\)/);
    expect(page.warnings.find((warning) => warning.startsWith('WATCHLIST_FIELDS_NULL')) ?? '').not.toMatch(/sellerText/);
  });

  it('surfaces the plain-text shipping line exactly as rendered', () => {
    for (const row of page.candidates) expect(row.shippingSnippetText).toBe('+C $38.80 Shipping');
  });

  it('keeps eBay\'s C$ conversion as snippetPrice and says, per row, that it is a conversion of the seller\'s ask', () => {
    expect(byId('377449134404').snippetPrice).toEqual({ value: 29.93, currency: 'CAD' });
    expect(byId('377449134404').snippetPriceSource).toBe('text');
    expect(byId('315012183531').snippetPrice).toEqual({ value: 412, currency: 'CAD' });
    const converted = page.warnings.find((warning) => warning.startsWith('WATCHLIST_PRICE_CONVERTED'));
    expect(converted).toBeDefined();
    expect(converted).toMatch(/377449134404/);
    expect(converted).toMatch(/GBP 16\.00/);
    expect(converted).toMatch(/conversion/i);
    expect(converted).toMatch(/not the seller's ask/);
    // The three un-converted rows are not named.
    expect(converted).not.toMatch(/315012183531|226934512873|146872203419/);
  });

  it('the chip carousel\'s "Go to next slide" button is not pagination', () => {
    expect(page.hasNextPage).toBe(false);
    expect(page.nextPageUrl).toBeNull();
  });
});

// The same fire's total-count rules, on synthetic pages, so each rule is
// pinned on its own: a chip is never a count source even when it sits in
// the label selectors, a genuine below-rows label is still rejected, and a
// real "All (N)" tab beside the chips still wins.
describe('watch list: category-filter chips are never the list total (2026-09-05 15:30Z fire)', () => {
  const chip =
    `<a href="https://www.ebay.ca/myb/Watchlist?custom_list_id=WATCH_LIST&amp;filter=category:175669" aria-label="Filter Watchlist by category: Drives, Storage &amp; Blank Media, 1 item">Drives, Storage &amp; Blank Media (1)<span>1 item</span></a>`;
  const rows = Array.from(
    { length: 3 },
    (_, index) =>
      `<li><a href="https://www.ebay.ca/itm/28713881074${index}"></a><h3>Item ${index}</h3><a href="https://www.ebay.ca/itm/28713881074${index}">Item ${index}</a><span>C $${10 + index}.00</span><a href="https://www.ebay.ca/itm/28713881074${index}">Buy It Now</a></li>`,
  ).join('');
  function doc(head: string): Document {
    const { document } = parseHTML(`<html><head><title>Watch list | My eBay</title></head><body>${head}<ul>${rows}</ul></body></html>`);
    return document as unknown as Document;
  }

  it('a chip inside a tablist is skipped as a count source, and the page says the total is unstated', () => {
    const page = extractWatchlistPage(doc(`<div role="tablist">${chip}</div>`), 'https://www.ebay.ca/mye/myebay/watchlist', { observedAt: OBSERVED_AT });
    expect(page.candidates).toHaveLength(3);
    expect(page.totalCount).toBeNull();
    expect(page.warnings.some((warning) => warning.startsWith('WATCHLIST_TOTAL_REJECTED'))).toBe(false);
    expect(page.warnings.some((warning) => warning.startsWith('WATCHLIST_TOTAL_UNSTATED'))).toBe(true);
  });

  it('a chip named only by its aria-label (no filter= in the href) is skipped the same way', () => {
    const named = `<div role="tablist"><a href="https://www.ebay.ca/myb/Watchlist?x=1" aria-label="Filter Watchlist by category: Retail &amp; Services, 1 item">Retail &amp; Services (1)</a></div>`;
    const page = extractWatchlistPage(doc(named), 'https://www.ebay.ca/mye/myebay/watchlist', { observedAt: OBSERVED_AT });
    expect(page.totalCount).toBeNull();
    expect(page.warnings.some((warning) => warning.startsWith('WATCHLIST_TOTAL_UNSTATED'))).toBe(true);
  });

  it('an "All (N)" tab beside the chips is still the list total', () => {
    const page = extractWatchlistPage(
      doc(`<div role="tablist"><button role="tab">All (312)</button></div><div>${chip}</div>`),
      'https://www.ebay.ca/mye/myebay/watchlist',
      { observedAt: OBSERVED_AT },
    );
    expect(page.totalCount).toBe(312);
    expect(page.totalCountSource).toBe('All (312)');
    expect(page.warnings.some((warning) => warning.startsWith('WATCHLIST_TOTAL_UNSTATED'))).toBe(false);
  });

  it('a genuine below-rows label with no chips on the page is still rejected, not unstated', () => {
    const page = extractWatchlistPage(doc('<h2>1 item</h2>'), 'https://www.ebay.ca/mye/myebay/watchlist', { observedAt: OBSERVED_AT });
    expect(page.totalCount).toBeNull();
    expect(page.warnings.some((warning) => warning.startsWith('WATCHLIST_TOTAL_REJECTED'))).toBe(true);
    expect(page.warnings.some((warning) => warning.startsWith('WATCHLIST_TOTAL_UNSTATED'))).toBe(false);
  });

  it('a page with no chips and no count label stays silent about the total, exactly as before', () => {
    const page = extractWatchlistPage(doc(''), 'https://www.ebay.ca/mye/myebay/watchlist', { observedAt: OBSERVED_AT });
    expect(page.totalCount).toBeNull();
    expect(page.warnings.some((warning) => /^WATCHLIST_TOTAL_/.test(warning))).toBe(false);
  });
});

// The action-link format rule on its own: only the link's or button's own
// text discriminates, a title that says "Buy It Now" does not, and a row
// that renders both controls is an auction with a Buy It Now.
describe('watch list: the action link discriminates the format (2026-09-05 15:30Z fire)', () => {
  function doc(rows: string): Document {
    const { document } = parseHTML(`<html><head><title>Watch list | My eBay</title></head><body><ul>${rows}</ul></body></html>`);
    return document as unknown as Document;
  }
  // Live node order: the shipping line sits between the price and the
  // action links. (Abutting them — "C $20.00Bid Now" — makes the generic
  // bid-count regex read "00Bid" as a bid count, a separate quirk of the
  // concatenated template that this block does not test.)
  const row = (id: string, title: string, actions: string) =>
    `<li><a href="https://www.ebay.ca/itm/${id}"></a><h3>${title}</h3><a href="https://www.ebay.ca/itm/${id}">${title}</a><span>C $20.00</span><span>+C $5.00 Shipping</span>${actions}<button>More Actions</button></li>`;

  it('"Place bid" is an auction and a "Buy It Now" button is fixed price', () => {
    const page = extractWatchlistPage(
      doc(
        row('100000000001', 'Lot A', '<a href="https://www.ebay.ca/itm/100000000001">Place bid</a>') +
          row('100000000002', 'Lot B', '<button type="button">Buy It Now</button>'),
      ),
      'https://www.ebay.ca/mye/myebay/watchlist',
      { observedAt: OBSERVED_AT },
    );
    expect(page.candidates.map((candidate) => candidate.sellingFormat)).toEqual(['auction', 'fixed_price']);
    expect(page.candidates.map((candidate) => candidate.bidCount)).toEqual([null, null]);
  });

  it('both controls on one row is auction_with_bin', () => {
    const page = extractWatchlistPage(
      doc(row('100000000003', 'Lot C', '<a href="https://www.ebay.ca/itm/100000000003">Bid Now</a><a href="https://www.ebay.ca/itm/100000000003">Buy It Now</a>')),
      'https://www.ebay.ca/mye/myebay/watchlist',
      { observedAt: OBSERVED_AT },
    );
    expect(page.candidates[0]!.sellingFormat).toBe('auction_with_bin');
  });

  it('a title that says Buy It Now is the seller talking, never the format; a row with no action link stays unknown', () => {
    const page = extractWatchlistPage(
      doc(row('100000000004', 'BUY IT NOW cheap Lego lot', '') + row('100000000005', 'Lot E', '<a href="https://www.ebay.ca/itm/100000000005">View seller\'s other items</a>')),
      'https://www.ebay.ca/mye/myebay/watchlist',
      { observedAt: OBSERVED_AT },
    );
    expect(page.candidates.map((candidate) => candidate.sellingFormat)).toEqual(['unknown', 'unknown']);
    expect(page.warnings.find((warning) => warning.startsWith('WATCHLIST_FORMAT_UNSTATED'))).toMatch(/2 of 2/);
  });
});
