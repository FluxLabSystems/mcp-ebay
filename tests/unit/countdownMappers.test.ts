/**
 * Countdown API mappers against the demo and Phase 0 fixtures
 * (docs/COUNTDOWN-API-PLAN.md §4, §6.6). Every rule here rests on a measured
 * vendor behaviour recorded in the fixture READMEs under tests/fixtures/countdown/.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BridgeError } from '@browser-bridge/protocol';
import { EBAY_API_PROFILE_REVISION, ExtractionRecordSchema } from '@browser-bridge/site-ebay';
import {
  DESTINATION_UNVERIFIED_WARNING,
  mapItem,
  mapSearchRows,
  mapSellerProfile,
  mergeSplitSearch,
  normalizeCondition,
  parseSellerLink,
  readPagination,
  type ApiListingCandidate,
} from '@browser-bridge/source-countdown';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'countdown');

type Json = Record<string, unknown>;

function load(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Json;
}

function rows(body: Json): Json[] {
  return body.search_results as Json[];
}

function idOf(row: Json): string {
  return /\/itm\/(\d+)/.exec(row.link as string)![1]!;
}

const OBSERVED_AT = '2026-09-02T18:00:00.000Z';
const KNOWN_TOKENS = new Set([
  'Brand New',
  'Pre-Owned',
  'New (Other)',
  'Open Box',
  'Good - Refurbished',
  'Excellent - Refurbished',
  'Very Good - Refurbished',
  'Parts Only',
]);

const caZip = load('demo/search-ca-memory-zip-M6H2W9.json');
const caTwoPages = load('demo/search-ca-memory-zip-num240-max2.json');
const comZip = load('demo/search-com-memory-zip-34249.json');
const legoUnfiltered = load('keyed/search-ca-lego-minifig-newly-listed.json');
const legoAuction = load('keyed/search-ca-lego-minifig-auction-newly-listed.json');

describe('mapSearchRows (§4.1)', () => {
  const { value: candidates, warnings } = mapSearchRows({ body: caZip, domain: 'ebay.ca', retrievedUnder: 'buy_it_now' });
  const byId = new Map(candidates.map((candidate) => [candidate.itemId, candidate]));

  it('keeps every ebay.ca row, takes the item id from the link and canonicalises the URL', () => {
    expect(rows(caZip)).toHaveLength(60);
    expect(candidates).toHaveLength(60);
    const first = candidates[0]!;
    expect(first.itemId).toBe('366642909023');
    expect(first.url).toBe('https://www.ebay.ca/itm/366642909023');
    expect(first.order).toBe(0);
    expect(candidates[59]!.order).toBe(59);
    expect(first.title).toBe('GIGASTONE 32GB SD Card UHS-I U1 Class 10 SDHC Memory Card High-Speed Full HD');
  });

  it('never reads epid as the item id', () => {
    const body = structuredClone(caZip);
    const tampered = rows(body)[0]!;
    tampered.epid = '8030522363';
    const { value } = mapSearchRows({ body, domain: 'ebay.ca', retrievedUnder: 'buy_it_now' });
    expect(value[0]!.itemId).toBe('366642909023');
  });

  it('drops a row whose link yields no item id and counts it in CANDIDATE_FIELDS_NULL', () => {
    const body = structuredClone(caZip);
    rows(body)[0]!.link = 'https://www.ebay.ca/b/Memory-Cards/18871/bn_1865497';
    delete rows(body)[1]!.link;
    const { value, warnings: dropped } = mapSearchRows({ body, domain: 'ebay.ca', retrievedUnder: 'buy_it_now' });
    expect(value).toHaveLength(58);
    expect(dropped.find((w) => w.startsWith('CANDIDATE_FIELDS_NULL:'))).toMatch(/2 row\(s\)/);
  });

  it('parses the currency from raw text because rows carry no currency field', () => {
    expect(rows(caZip).every((row) => ((row.prices as Json[] | undefined) ?? []).every((p) => !('currency' in p)))).toBe(true);
    expect(candidates[0]!.snippetPrice).toEqual({ value: 20, currency: 'CAD' });
    const com = mapSearchRows({ body: comZip, domain: 'ebay.com', retrievedUnder: 'buy_it_now' }).value;
    expect(com[0]!.snippetPrice).toEqual({ value: 40.61, currency: 'USD' });
  });

  it('falls back to the domain currency when raw is missing', () => {
    const body = structuredClone(comZip);
    const row = rows(body)[0]!;
    row.price = { value: 12.5 };
    row.prices = [{ value: 12.5 }];
    const { value } = mapSearchRows({ body, domain: 'ebay.com', retrievedUnder: 'buy_it_now' });
    expect(value[0]!.snippetPrice).toEqual({ value: 12.5, currency: 'USD' });
    const ca = mapSearchRows({ body, domain: 'ebay.ca', retrievedUnder: 'buy_it_now' }).value;
    expect(ca[0]!.snippetPrice).toEqual({ value: 12.5, currency: 'CAD' });
  });

  it('strips the leaked " to" from range titles, keeps price-less range rows and counts them once', () => {
    const rangeRows = rows(caZip).filter((row) => /\sto$/.test(row.title as string));
    const priceless = rangeRows.filter((row) => !row.price && !(row.prices as unknown[] | undefined)?.length);
    expect(rangeRows).toHaveLength(30);
    expect(priceless).toHaveLength(21);
    for (const row of priceless) {
      const candidate = byId.get(idOf(row))!;
      expect(candidate.priceRange).toBe(true);
      expect(candidate.snippetPrice).toBeNull();
      expect(candidate.snippetPriceHigh).toBeNull();
      expect(candidate.title).not.toMatch(/\sto$/);
    }
    const smartMedia = byId.get('145808351817')!;
    expect(smartMedia.title).toBe('SmartMedia Card 128MB SM Card SM Memory Card + Smart Media Memory Cards Reader');
    expect(smartMedia.itemLocationText).toBe('china');
    const rangeWarnings = warnings.filter((w) => w.startsWith('PRICE_RANGE_UNPARSED:'));
    expect(rangeWarnings).toHaveLength(1);
    expect(rangeWarnings[0]).toMatch(/21 variant listing/);
    expect(candidates.every((candidate) => !/\sto$/.test(candidate.title ?? ''))).toBe(true);
  });

  it('splits a two-entry range into the low snippetPrice and snippetPriceHigh', () => {
    const twoPrice = rows(caZip).filter((row) => (row.prices as unknown[] | undefined)?.length === 2);
    expect(twoPrice).toHaveLength(9);
    for (const row of twoPrice) {
      const candidate = byId.get(idOf(row))!;
      const values = (row.prices as Json[]).map((p) => p.value as number);
      expect(candidate.priceRange).toBe(true);
      expect(candidate.snippetPrice).toEqual({ value: Math.min(...values), currency: 'CAD' });
      expect(candidate.snippetPriceHigh).toEqual({ value: Math.max(...values), currency: 'CAD' });
    }
    const com = mapSearchRows({ body: comZip, domain: 'ebay.com', retrievedUnder: 'buy_it_now' });
    const comRanges = com.value.filter((candidate) => candidate.snippetPriceHigh !== null);
    expect(comRanges).toHaveLength(44);
    const youPick = com.value.find((candidate) => candidate.title?.startsWith('Memory Stick Pro Duo MagicGate'))!;
    expect(youPick.title).toBe('Memory Stick Pro Duo MagicGate Card for Sony PSP Cybershot 1 2 4 8gb - You Pick');
    expect(youPick.snippetPrice).toEqual({ value: 13.97, currency: 'USD' });
    expect(youPick.snippetPriceHigh).toEqual({ value: 15.17, currency: 'USD' });
    expect(com.warnings.some((w) => w.startsWith('PRICE_RANGE_UNPARSED:'))).toBe(false);
  });

  it('takes the selling format from the filter only, never from is_auction / buy_it_now', () => {
    expect(rows(caZip).every((row) => row.is_auction === false && row.buy_it_now === false)).toBe(true);
    expect(candidates.every((candidate) => candidate.sellingFormat === 'fixed_price')).toBe(true);
    const auction = mapSearchRows({ body: caZip, domain: 'ebay.ca', retrievedUnder: 'auction' }).value;
    expect(auction.every((candidate) => candidate.sellingFormat === 'auction')).toBe(true);
    const offers = mapSearchRows({ body: caZip, domain: 'ebay.ca', retrievedUnder: 'accepts_offers' }).value;
    expect(offers.every((candidate) => candidate.sellingFormat === 'fixed_price')).toBe(true);
    // The auction-filtered fixture reads is_auction: true on every row; retrieved under
    // buy_it_now it would still be fixed_price, which proves the flag is never read.
    expect(rows(legoAuction).every((row) => row.is_auction === true)).toBe(true);
    const flagsIgnored = mapSearchRows({ body: legoAuction, domain: 'ebay.ca', retrievedUnder: 'buy_it_now' }).value;
    expect(flagsIgnored.every((candidate) => candidate.sellingFormat === 'fixed_price')).toBe(true);
  });

  it('marks an unfiltered search unknown with one warning', () => {
    const { value, warnings: unfiltered } = mapSearchRows({ body: caZip, domain: 'ebay.ca', retrievedUnder: 'unfiltered' });
    expect(value.every((candidate) => candidate.sellingFormat === 'unknown')).toBe(true);
    expect(unfiltered.filter((w) => w.startsWith('FORMAT_UNKNOWN_ON_UNFILTERED_SEARCH:'))).toHaveLength(1);
  });

  it('carries no bid count, no shipping snippet text and no new-listing badge', () => {
    expect(candidates.every((candidate) => candidate.bidCount === null)).toBe(true);
    expect(candidates.every((candidate) => candidate.shippingSnippetText === null)).toBe(true);
    expect(candidates.every((candidate) => candidate.isNewListing === null)).toBe(true);
    expect(warnings.filter((w) => w.startsWith('BID_COUNT_UNAVAILABLE_FROM_SOURCE:'))).toHaveLength(1);
  });

  it('reads shipping_cost as a number and leaves it null when absent (never free)', () => {
    expect(candidates[0]!.shippingCost).toBe(5);
    const withCost = rows(caZip).filter((row) => typeof row.shipping_cost === 'number');
    expect(withCost).toHaveLength(40);
    expect(candidates.filter((candidate) => candidate.shippingCost !== null)).toHaveLength(40);
    expect(candidates.filter((candidate) => candidate.shippingCost === null)).toHaveLength(20);
  });

  it('passes seller_info through with review_count parsed to an int', () => {
    expect(candidates[0]).toMatchObject({ sellerName: 'skeenas_73', sellerReviewCount: 0, sellerPositivePercent: 0 });
    const rich = candidates.find((candidate) => candidate.itemId === '145808351817')!;
    expect(rich).toMatchObject({ sellerName: 'jiacheng-electron', sellerReviewCount: 126, sellerPositivePercent: 100 });
    const auctionLayout = mapSearchRows({ body: legoAuction, domain: 'ebay.ca', retrievedUnder: 'auction' }).value;
    expect(auctionLayout.every((candidate) => candidate.sellerName === null && candidate.sellerReviewCount === null)).toBe(true);
    expect(candidates.every((candidate) => candidate.sponsored === false)).toBe(true);
    expect(candidates.some((candidate) => candidate.bestOffer === true)).toBe(true);
  });

  it('normalises the condition to the trailing vocabulary token and keeps the raw when it differed', () => {
    const glued = rows(caZip).filter((row) => typeof row.condition === 'string' && !KNOWN_TOKENS.has(row.condition));
    expect(glued.length).toBeGreaterThan(0);
    for (const row of glued) {
      const candidate = byId.get(idOf(row))!;
      expect(KNOWN_TOKENS.has(candidate.condition!)).toBe(true);
      expect(candidate.conditionRaw).toBe(row.condition);
      expect((row.condition as string).endsWith(candidate.condition!)).toBe(true);
    }
    const plain = candidates.filter((candidate) => candidate.conditionRaw === null);
    expect(plain.length).toBe(60 - glued.length);
    expect(plain.every((candidate) => KNOWN_TOKENS.has(candidate.condition!))).toBe(true);
    expect(candidates[0]).toMatchObject({ condition: 'Brand New', conditionRaw: null });
  });

  it('strips "located in " from ebay.com locations', () => {
    expect(rows(comZip).every((row) => /^located in /.test(row.item_location as string))).toBe(true);
    const com = mapSearchRows({ body: comZip, domain: 'ebay.com', retrievedUnder: 'buy_it_now' }).value;
    expect(com[0]!.itemLocationText).toBe('china');
    expect(com.every((candidate) => candidate.itemLocationText !== null && !/located in/i.test(candidate.itemLocationText))).toBe(true);
  });

  it('excludes rewritten rows and counts them', () => {
    const body = structuredClone(caZip);
    rows(body)[3]!.is_rewritten_result = true;
    rows(body)[7]!.is_rewritten_result = true;
    const { value, warnings: rewritten } = mapSearchRows({ body, domain: 'ebay.ca', retrievedUnder: 'buy_it_now' });
    expect(value).toHaveLength(58);
    expect(rewritten.find((w) => w.startsWith('EXCLUDED_REWRITTEN:'))).toMatch(/2 row\(s\)/);
    expect(value.some((candidate) => candidate.itemId === idOf(rows(caZip)[3]!))).toBe(false);
  });

  it('uses position_overall for order and page on a multi-page response', () => {
    const { value } = mapSearchRows({ body: caTwoPages, domain: 'ebay.ca', retrievedUnder: 'buy_it_now' });
    expect(value).toHaveLength(480);
    expect(value[0]).toMatchObject({ order: 0, page: 1, positionOverall: 1 });
    expect(value[479]).toMatchObject({ order: 479, page: 2, positionOverall: 480 });
    expect(candidates[0]!.positionOverall).toBeNull();
    expect(mapSearchRows({ body: caZip, domain: 'ebay.ca', retrievedUnder: 'buy_it_now', page: 3 }).value[0]!.page).toBe(3);
  });

  it('rejects a body that is not a search response with EXTRACTION_INCOMPLETE naming the path', () => {
    let caught: unknown;
    try {
      mapSearchRows({ body: { search_results: 'nope' }, domain: 'ebay.ca', retrievedUnder: 'buy_it_now' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe('EXTRACTION_INCOMPLETE');
    expect((caught as BridgeError).message).toContain('search_results');
  });
});

describe('readPagination', () => {
  it('reads the flat pagination object', () => {
    expect(readPagination(caZip)).toEqual({ totalResults: 76000, hasNextPage: true, pagesFetched: 1, currentPage: 1 });
    expect(readPagination(comZip)).toEqual({ totalResults: 80000, hasNextPage: true, pagesFetched: 1, currentPage: 1 });
  });

  it('folds pagination.pages[] into the last page flag and the page count', () => {
    expect(readPagination(caTwoPages)).toEqual({ totalResults: 76000, hasNextPage: true, pagesFetched: 2, currentPage: 2 });
    const body = structuredClone(caTwoPages);
    ((body.pagination as Json).pages as Json[])[1]!.has_next_page = false;
    expect(readPagination(body).hasNextPage).toBe(false);
  });

  it('reports nothing fetched on an empty body', () => {
    expect(readPagination({})).toEqual({ totalResults: null, hasNextPage: null, pagesFetched: 0, currentPage: null });
  });
});

describe('mergeSplitSearch (§3.1)', () => {
  const unfilteredIds = new Set(rows(legoUnfiltered).map(idOf));
  const auctionIds = new Set(rows(legoAuction).map(idOf));
  const overlap = [...unfilteredIds].filter((id) => auctionIds.has(id));

  it('has the measured 30-id overlap, all reading is_auction: false on the unfiltered page', () => {
    expect(overlap).toHaveLength(30);
    expect(rows(legoUnfiltered).every((row) => row.is_auction === false && row.buy_it_now === false)).toBe(true);
  });

  it('marks overlapping ids auction when the first set was unfiltered, and never reads flags', () => {
    const primary = mapSearchRows({ body: legoUnfiltered, domain: 'ebay.ca', retrievedUnder: 'unfiltered' }).value;
    const auction = mapSearchRows({ body: legoAuction, domain: 'ebay.ca', retrievedUnder: 'auction' }).value;
    const merged = mergeSplitSearch(primary, auction);
    expect(merged).toHaveLength(450);
    const kinds = (kind: ApiListingCandidate['sellingFormat']) => merged.filter((c) => c.sellingFormat === kind);
    expect(kinds('auction')).toHaveLength(240);
    expect(kinds('unknown')).toHaveLength(210);
    expect(kinds('auction_with_bin')).toHaveLength(0);
    for (const id of overlap) expect(merged.find((c) => c.itemId === id)!.sellingFormat).toBe('auction');
    expect(merged.map((c) => c.order)).toEqual(merged.map((_, i) => i));
    expect(new Set(merged.map((c) => c.itemId)).size).toBe(450);
  });

  it('marks overlapping ids auction_with_bin when the first set was buy_it_now', () => {
    const bin = mapSearchRows({ body: legoUnfiltered, domain: 'ebay.ca', retrievedUnder: 'buy_it_now' }).value;
    const auction = mapSearchRows({ body: legoAuction, domain: 'ebay.ca', retrievedUnder: 'auction' }).value;
    const merged = mergeSplitSearch(bin, auction);
    expect(merged.filter((c) => c.sellingFormat === 'auction_with_bin').map((c) => c.itemId).sort()).toEqual([...overlap].sort());
    expect(merged.filter((c) => c.sellingFormat === 'fixed_price')).toHaveLength(210);
    expect(merged.filter((c) => c.sellingFormat === 'auction')).toHaveLength(210);
    // The auction layout carries shipping on nearly every row; the merged entry borrows it.
    const withBorrowed = merged.filter((c) => c.sellingFormat === 'auction_with_bin' && c.shippingCost !== null);
    expect(withBorrowed.length).toBeGreaterThan(0);
  });

  it('maps the auction layout: current bid as snippetPrice, shipping on the row, no seller_info', () => {
    const auction = mapSearchRows({ body: legoAuction, domain: 'ebay.ca', retrievedUnder: 'auction' }).value;
    expect(auction[0]).toMatchObject({
      itemId: '168658364834',
      snippetPrice: { value: 37.54, currency: 'CAD' },
      shippingCost: 80.29,
      itemLocationText: 'united kingdom',
      condition: 'Pre-Owned',
      sellingFormat: 'auction',
      bidCount: null,
      sellerName: null,
    });
  });
});

describe('mapItem (§4.2)', () => {
  const sold = load('keyed/product-ca-needs-revalidation-398236132742.json');
  const ended = load('keyed/product-ca-198589141532-ended.json');
  const liveAuction = load('keyed/product-ca-168658364834-live-auction.json');
  const activeTiers = load('keyed/product-ca-331982822376-active-tiers.json');
  const schSeller = load('keyed/product-ca-287557851282.json');
  const notFound = load('demo/product-not-found-ca.json');

  function map(body: Json, expectedFormat?: 'auction' | 'auction_with_bin' | 'fixed_price', requestedUrl?: string) {
    const result = mapItem({ body, domain: 'ebay.ca', requestedUrl: requestedUrl ?? null, expectedFormat, observedAt: OBSERVED_AT });
    expect(ExtractionRecordSchema.parse(result.record)).toBeTruthy();
    expect(result.record.siteProfile).toBe('ebay.api.v1');
    expect(result.record.profileRevision).toBe(EBAY_API_PROFILE_REVISION);
    expect(result.record.pageRevision).toBe(0);
    expect(result.record.observedAt).toBe(OBSERVED_AT);
    expect(result.warnings).toContain(DESTINATION_UNVERIFIED_WARNING);
    return result;
  }

  it('maps a sold listing: stock_status sold, store-slug seller, "C $" shipping as observed text', () => {
    const { status, record, warnings } = map(sold, 'fixed_price');
    expect(status).toBe('ok');
    expect(record.listingStatus).toBe('sold');
    expect(record.itemId).toEqual({ value: '398236132742', source: 'api', confidence: 0.98 });
    expect(record.canonicalUrl).toEqual({ value: 'https://www.ebay.ca/itm/398236132742', source: 'computed', confidence: 1 });
    expect(record.seller).toBeNull();
    expect(record.sellerStoreSlug).toMatchObject({ value: 'zoomtreasury', source: 'api' });
    expect(record.sellerDisplayName).toMatchObject({ value: 'ZoomTreasury', source: 'api' });
    expect(record.sellerProfileUrl?.value).toBe('https://www.ebay.ca/str/zoomtreasury');
    expect(record.itemPrice).toEqual({ value: 62.99, currency: 'CAD', source: 'api', confidence: 0.95 });
    expect(record.shipping).toEqual({
      value: 68.71,
      currency: 'CAD',
      source: 'api',
      confidence: 0.9,
      destinationPostalCode: null,
      destinationVerified: false,
      observedText: 'C $68.71 (UPS Standard United States)',
    });
    expect(record.quantityAvailable).toEqual({ value: 0, source: 'api', confidence: 0.95 });
    expect(record.itemLocationText?.value).toBe('Lachute, Quebec, Canada');
    expect(record.shipsToText?.value).toBe('Canada, United States');
    expect(warnings.some((w) => w.startsWith('SELLER_LOGIN_ID_UNAVAILABLE:'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('AUCTION_'))).toBe(false);
  });

  it('maps an ended listing with no message and "Free" shipping', () => {
    const { record } = map(ended, 'fixed_price');
    expect(record.listingStatus).toBe('ended');
    expect(record.itemId?.value).toBe('198589141532');
    expect(record.shipping).toMatchObject({ value: 0, currency: 'CAD', observedText: 'Free (USPS Ground Advantage)', destinationVerified: false });
    expect(record.sellerStoreSlug?.value).toBe('ourdogrocky');
    expect(record.itemPrice).toMatchObject({ value: 66, currency: 'CAD' });
  });

  it('nulls the price and auction detail on an expected auction, ignoring the page\'s is_auction and offer', () => {
    expect(liveAuction.is_auction).toBe(false);
    expect((liveAuction.offer as Json).price).toBe(19.99);
    const { status, record, warnings } = map(liveAuction, 'auction');
    expect(status).toBe('ok');
    expect(record.sellingFormat).toEqual({ kind: 'auction', bidCount: null, source: 'computed', confidence: 0.9 });
    expect(record.itemPrice).toBeNull();
    expect(record.endsAt).toBeNull();
    expect(record.timeLeftText).toBeNull();
    expect(record.listingStatus).toBe('active');
    expect(record.seller).toEqual({ value: 'jasscen', source: 'api', confidence: 0.98 });
    expect(record.shipping).toMatchObject({ value: 50.68, currency: 'GBP', confidence: 0.9 });
    expect(warnings.some((w) => w.startsWith('AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE:'))).toBe(true);
    expect(warnings.find((w) => w.startsWith('AUCTION_PRICE:'))).toContain('19.99 CAD');
    const withBin = map(liveAuction, 'auction_with_bin');
    expect(withBin.record.sellingFormat.kind).toBe('auction_with_bin');
    expect(withBin.record.itemPrice).toBeNull();
  });

  it('reads the auction block when the vendor supplies one', () => {
    const body = structuredClone(liveAuction);
    body.auction = { bids: 7, time_left: { raw: '2d 4h' }, end_date: { utc: '2026-09-05T15:03:00.000Z' } };
    const { record } = map(body, 'auction');
    expect(record.sellingFormat.bidCount).toBe(7);
    expect(record.endsAt).toEqual({ value: '2026-09-05T15:03:00.000Z', source: 'api', confidence: 0.95 });
    expect(record.timeLeftText).toEqual({ value: '2d 4h', source: 'api', confidence: 0.95 });
    expect(record.itemPrice).toBeNull();
  });

  it('maps a live fixed-price tier lot: /str/ slug, bare-number shipping at 0.4, quantities, specifics', () => {
    const { status, record, warnings } = map(activeTiers, 'fixed_price');
    expect(status).toBe('ok');
    expect(record.listingStatus).toBe('active');
    expect(record.itemId).toEqual({ value: '331982822376', source: 'api', confidence: 0.98 });
    expect(record.title?.value).toBe('LEGO - Printed Tiles Lot 1x1 1x2 2x2 - Decorated Flat Plate Smooth Round Square');
    expect(record.itemPrice).toEqual({ value: 2.29, currency: 'CAD', source: 'api', confidence: 0.95 });
    expect(record.sellingFormat.kind).toBe('fixed_price');
    expect(record.seller).toBeNull();
    expect(record.sellerStoreSlug?.value).toBe('almtshop88');
    expect(record.sellerDisplayName?.value).toBe('Bluebird Brick Designs');
    expect(record.shipping).toEqual({
      value: 7.95,
      currency: 'CAD',
      source: 'api',
      confidence: 0.4,
      destinationPostalCode: null,
      destinationVerified: false,
      observedText: '7.95 (Standard Shipping)',
    });
    expect(record.quantityAvailable).toEqual({ value: 5, source: 'api', confidence: 0.95 });
    expect(record.quantitySold).toEqual({ value: 121, source: 'api', confidence: 0.95 });
    expect(record.imageCount).toEqual({ value: 4, source: 'api', confidence: 0.95 });
    expect(record.attributes).toHaveLength(4);
    expect(record.attributes?.[0]).toEqual({ name: 'Condition', value: 'Used' });
    expect(record.categories).toEqual(['Toys & Hobbies', 'Building Toys', 'LEGO (R) Building Toys', 'LEGO (R) Bricks, Pieces & Parts']);
    expect(record.conditionText).toMatchObject({ value: 'Used', source: 'api' });
    expect(record.returnsText?.value).toBe('30 days return. Seller pays for return shipping.');
    expect(record.returnsAccepted).toEqual({ value: true, source: 'api', confidence: 1 });
    expect(record.deliveryEstimateText?.value).toBe('Thu, Sep 10 and Wed, Sep 16');
    expect(record.shipsToText?.value).toBe('Albania, Algeria, American Samoa, and many other countries');
    expect(record.itemLocationText?.value).toBe('Reno, Nevada, United States');
    expect(record.offer).toEqual({ available: false, sellerOfferPrice: null, expiresAt: null });
    expect(record.makeOffer).toBeNull();
    expect(record.variants).toBeNull();
    expect(record.watcherCount).toBeNull();
    expect(warnings.some((w) => w.startsWith('AUCTION_'))).toBe(false);
  });

  it('caps attributes at 40 and reads make_offer', () => {
    const body = structuredClone(activeTiers);
    const product = body.product as Json;
    product.attributes = Array.from({ length: 50 }, (_, i) => ({ name: `Spec ${i}`, value: `v${i}` }));
    body.make_offer = true;
    const { record } = map(body, 'fixed_price');
    expect(record.attributes).toHaveLength(40);
    expect(record.offer.available).toBe(true);
    expect(record.makeOffer).toEqual({ value: true, source: 'api', confidence: 1 });
  });

  it('reads the login id from a /sch/<id>/m.html link and an ISO-prefixed shipping string', () => {
    const { record } = map(schSeller, 'fixed_price');
    expect(record.seller).toEqual({ value: 'bageltremors', source: 'api', confidence: 0.98 });
    expect(record.sellerStoreSlug).toBeNull();
    expect(record.shipping).toMatchObject({
      value: 21.56,
      currency: 'GBP',
      confidence: 0.9,
      observedText: 'GBP 21.56 (International Priority Shipping)',
    });
    expect(record.itemPrice).toMatchObject({ value: 15, currency: 'CAD' });
    expect(record.listingStatus).toBe('active');
    // quantity_available: 0 on an in-stock listing means "not shown".
    expect((schSeller.stock_status as Json).quantity_available).toBe(0);
    expect(record.quantityAvailable).toBeNull();
  });

  it('cross-checks product.epid against the link and lets the link win', () => {
    const body = structuredClone(activeTiers);
    const product = body.product as Json;
    product.link = 'https://www.ebay.ca/itm/331982822376?hash=abc';
    product.epid = '8030522363';
    const { record, warnings } = map(body, 'fixed_price');
    expect(record.itemId).toEqual({ value: '331982822376', source: 'api', confidence: 1 });
    expect(warnings.find((w) => w.startsWith('ITEM_ID_MISMATCH:'))).toContain('8030522363');
  });

  it('falls back to the requested URL for the item id when the body carries none', () => {
    const body = structuredClone(activeTiers);
    delete (body.request_metadata as Json).ebay_url;
    delete (body.request_parameters as Json).url;
    const { record } = map(body, 'fixed_price', 'https://www.ebay.ca/itm/331982822376');
    expect(record.itemId).toEqual({ value: '331982822376', source: 'computed', confidence: 0.9 });
  });

  it('reports unknown format without expectedFormat but still reads the fixed offer', () => {
    const { record, warnings } = map(activeTiers);
    expect(record.sellingFormat.kind).toBe('unknown');
    expect(record.itemPrice?.value).toBe(2.29);
    expect(warnings.some((w) => w.startsWith('FORMAT_UNKNOWN_FROM_SOURCE:'))).toBe(true);
  });

  it('maps "Product not found." to unavailable with the id from the resolved URL', () => {
    const { status, record, warnings } = map(notFound);
    expect(status).toBe('unavailable');
    expect(record.listingStatus).toBe('unavailable');
    expect(record.itemId).toEqual({ value: '233599133856', source: 'api', confidence: 0.98 });
    expect(record.canonicalUrl?.value).toBe('https://www.ebay.ca/itm/233599133856');
    expect(record.title).toBeNull();
    expect(record.itemPrice).toBeNull();
    expect(record.shipping).toBeNull();
    expect(warnings).toContain('LISTING_UNAVAILABLE: Product not found.');
    expect(record.sellingFormat.kind).toBe('unknown');
    expect(warnings.some((w) => w.startsWith('FORMAT_UNKNOWN_FROM_SOURCE:'))).toBe(false);
  });

  it('maps a redirect to unavailable without mapping the redirect target', () => {
    const body = structuredClone(activeTiers);
    body.redirected = true;
    body.redirected_link = 'https://www.ebay.ca/itm/111111111111';
    body.redirected_epid = '111111111111';
    const { status, record, warnings } = map(body, 'fixed_price');
    expect(status).toBe('unavailable');
    expect(record.listingStatus).toBe('unavailable');
    expect(record.itemId?.value).toBe('331982822376');
    expect(record.title).toBeNull();
    expect(warnings.find((w) => w.startsWith('LISTING_REDIRECTED:'))).toContain('111111111111');
  });

  it('treats a present end_date as ended and a string shipping number as domain currency', () => {
    const body = structuredClone(activeTiers);
    body.end_date = '2026-08-30T15:03:00Z';
    (body.shipping as Json).price = 12;
    const { record } = map(body, 'fixed_price');
    expect(record.listingStatus).toBe('ended');
    expect(record.shipping).toMatchObject({ value: 12, currency: 'CAD', confidence: 0.4, observedText: '12 (Standard Shipping)' });
  });

  it('keeps unparseable shipping text as observed text', () => {
    const body = structuredClone(activeTiers);
    (body.shipping as Json).price = 'See details';
    const { record, warnings } = map(body, 'fixed_price');
    expect(record.shipping).toMatchObject({ value: null, currency: null, confidence: 0.5, observedText: 'See details (Standard Shipping)' });
    expect(warnings.some((w) => w.startsWith('shipping text observed but not parseable'))).toBe(true);
  });

  it('marks every provenance field api except the computed canonical URL and caller-supplied format', () => {
    const { record } = map(activeTiers, 'fixed_price');
    const sources = new Set<string>();
    for (const [key, value] of Object.entries(record)) {
      if (value !== null && typeof value === 'object' && 'source' in value && key !== 'canonicalUrl' && key !== 'sellingFormat') {
        sources.add((value as { source: string }).source);
      }
    }
    expect([...sources]).toEqual(['api']);
  });

  it('rejects a non-product body with EXTRACTION_INCOMPLETE', () => {
    expect(() => mapItem({ body: { product: 'nope' }, domain: 'ebay.ca', observedAt: OBSERVED_AT })).toThrowError(BridgeError);
    try {
      mapItem({ body: { product: 'nope' }, domain: 'ebay.ca', observedAt: OBSERVED_AT });
    } catch (err) {
      expect((err as BridgeError).code).toBe('EXTRACTION_INCOMPLETE');
      expect((err as BridgeError).details.path).toBe('product');
    }
  });
});

describe('mapSellerProfile (§4.3)', () => {
  const profile = load('keyed/seller-profile-ca-usr-tweedsidesales.json');

  it('resolves the /usr/ login id from the requested URL and the store slug from the vendor link', () => {
    const { resolved, seller, warnings } = mapSellerProfile({ body: profile, requestedUrl: 'https://www.ebay.ca/usr/tweedsidesales' });
    expect(resolved).toBe(true);
    expect(warnings).toEqual([]);
    expect(seller).toEqual({
      name: 'Jeremy Doherty',
      profileUrl: 'https://www.ebay.ca/usr/tweedsidesales',
      loginId: 'tweedsidesales',
      storeSlug: 'jeremydoherty',
      storeUrl: 'https://www.ebay.ca/str/jeremydoherty',
      memberSince: null,
      positivePercent: 99.8,
      followers: 79,
      followersText: '79 followers',
      location: null,
      topRated: null,
      description: null,
      imageUrl: 'https://i.ebayimg.com/images/g/1tIAAOSweM5kSqsu/s-l140.png',
    });
  });

  it('falls back to the echoed request URL when no requested URL is given', () => {
    const { seller } = mapSellerProfile({ body: profile });
    expect(seller?.loginId).toBe('tweedsidesales');
    expect(seller?.profileUrl).toBe('https://www.ebay.ca/usr/tweedsidesales');
  });

  it('reads a /sch/<id>/m.html link as the login id and synthesises the profile URL', () => {
    const body = structuredClone(profile);
    (body.seller as Json).link = 'https://www.ebay.ca/sch/bageltremors/m.html?item=287557851282&rt=nc';
    delete (body.request_parameters as Json).url;
    delete (body.request_metadata as Json).ebay_url;
    const { seller } = mapSellerProfile({ body });
    expect(seller).toMatchObject({ loginId: 'bageltremors', storeSlug: null, profileUrl: 'https://www.ebay.ca/usr/bageltremors' });
  });

  it('is unresolved without a seller block or with an empty name', () => {
    const missing = mapSellerProfile({ body: { request_info: { success: true }, message: 'Seller not found.' } });
    expect(missing).toEqual({ resolved: false, seller: null, warnings: ['SELLER_UNRESOLVED: Seller not found.'] });
    const blank = mapSellerProfile({ body: { seller: { name: '  ', link: 'https://www.ebay.ca/usr/x' } } });
    expect(blank.resolved).toBe(false);
    expect(blank.seller).toBeNull();
  });

  it('warns when only a store page is known', () => {
    const { seller, warnings } = mapSellerProfile({ body: { seller: { name: 'Store', link: 'https://www.ebay.ca/str/somestore' } } });
    expect(seller).toMatchObject({ loginId: null, storeSlug: 'somestore', profileUrl: null });
    expect(warnings.some((w) => w.startsWith('SELLER_LOGIN_ID_UNAVAILABLE:'))).toBe(true);
  });
});

describe('helpers', () => {
  it('parses the three seller link forms', () => {
    expect(parseSellerLink('https://www.ebay.ca/usr/tweedsidesales')).toMatchObject({ kind: 'usr', loginId: 'tweedsidesales', storeSlug: null });
    expect(parseSellerLink('https://www.ebay.ca/sch/bageltremors/m.html?item=1')).toMatchObject({ kind: 'sch', loginId: 'bageltremors' });
    expect(parseSellerLink('https://www.ebay.ca/str/almtshop88')).toMatchObject({ kind: 'str', loginId: null, storeSlug: 'almtshop88' });
    expect(parseSellerLink('https://www.ebay.ca/itm/123456789012')).toMatchObject({ kind: null, loginId: null, storeSlug: null });
  });

  it('normalises the measured condition strings', () => {
    expect(normalizeCondition('Brand New')).toEqual({ condition: 'Brand New', conditionRaw: null });
    expect(normalizeCondition('100% GENUINE Kingston✔Shipped from USA✔Brand New')).toEqual({
      condition: 'Brand New',
      conditionRaw: '100% GENUINE Kingston✔Shipped from USA✔Brand New',
    });
    expect(normalizeCondition('Shop With Confidence\n Buy From NeweggBrand New').condition).toBe('Brand New');
    expect(normalizeCondition('Ships Tracked - Top Brands - Sony Sandisk or LexarGood - Refurbished').condition).toBe('Good - Refurbished');
    expect(normalizeCondition('Very Good - Refurbished').condition).toBe('Very Good - Refurbished');
    expect(normalizeCondition('ToshibaPre-Owned').condition).toBe('Pre-Owned');
    expect(normalizeCondition('New (Other)').condition).toBe('New (Other)');
    expect(normalizeCondition('Parts Only').condition).toBe('Parts Only');
    expect(normalizeCondition('For parts or not working').condition).toBe('For parts or not working');
    expect(normalizeCondition('Renew')).toEqual({ condition: 'Renew', conditionRaw: null });
    expect(normalizeCondition('')).toEqual({ condition: null, conditionRaw: null });
    expect(normalizeCondition(null)).toEqual({ condition: null, conditionRaw: null });
  });
});
