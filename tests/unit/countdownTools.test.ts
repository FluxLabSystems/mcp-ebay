/**
 * CountdownSource — docs/COUNTDOWN-API-PLAN.md §2, §6.5 and §6.6: the
 * credit reserve gate, the named-destination mapping, the split search,
 * the bounded item pool and per-slot failure, all against a stub vendor
 * with no gateway on the path.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { CountdownConfig } from '@browser-bridge/config';
import {
  CountdownSource,
  MemoryStore,
  registerSourceTools,
  runSourceTool,
  type CountdownSourceOptions,
  type SourceDeadline,
} from '@browser-bridge/gateway';
import {
  BridgeError,
  EbayApiItemsInput,
  EbayApiItemsOutput,
  EbayApiSearchInput,
  EbayApiSearchOutput,
  EbayApiSellerInput,
  EbayApiSellerOutput,
  ExtractManyOutput,
} from '@browser-bridge/protocol';

const API_KEY = 'cd-unit-SECRET-key';

interface VendorCall {
  url: URL;
  query: URLSearchParams;
}

type Responder = (call: VendorCall, ordinal: number) => Response | Promise<Response>;

function stubVendor(responder: Responder): { impl: typeof fetch; calls: VendorCall[] } {
  const calls: VendorCall[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const call = { url, query: url.searchParams };
    calls.push(call);
    return responder(call, calls.length);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Credits {
  used?: number | null;
  remaining?: number | null;
}

function requestInfo(credits: Credits = {}): Record<string, unknown> {
  return {
    success: true,
    credits_used: credits.used === undefined ? 10 : credits.used,
    credits_remaining: credits.remaining === undefined ? 990 : credits.remaining,
    credits_used_this_request: 1,
  };
}

let requestSeq = 0;
function metadata(ebayUrl: string): Record<string, unknown> {
  requestSeq += 1;
  return { id: `req_${requestSeq}`, ebay_url: ebayUrl };
}

function searchRow(id: string, price: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    position: 1,
    title: `LEGO lot ${id}`,
    epid: id,
    link: `https://www.ebay.ca/itm/${id}`,
    condition: 'Pre-Owned',
    is_auction: false,
    buy_it_now: false,
    item_location: 'canada',
    shipping_cost: 9.99,
    prices: [{ value: price, raw: `C $${price.toFixed(2)}` }],
    price: { value: price, raw: `C $${price.toFixed(2)}` },
    ...extra,
  };
}

function searchBody(rows: Record<string, unknown>[], credits: Credits = {}, total = rows.length): Record<string, unknown> {
  return {
    request_info: requestInfo(credits),
    request_metadata: metadata('https://www.ebay.ca/sch/i.html?_nkw=lego'),
    search_results: rows,
    pagination: { current_page: 1, total_results: total, has_next_page: false },
  };
}

function productBody(itemId: string, credits: Credits = {}): Record<string, unknown> {
  return {
    request_info: requestInfo(credits),
    request_metadata: metadata(`https://www.ebay.ca/itm/${itemId}?_fcid=2`),
    product: { title: `Item ${itemId}`, epid: itemId, link: `https://www.ebay.ca/itm/${itemId}`, images: [], image_count: 0 },
    is_auction: false,
    offer: { price: 12.5, currency: 'CAD' },
    stock_status: { in_stock: true, status: 'in_stock', quantity_available: 1, quantity_sold: 0 },
    seller: { name: 'Seller', link: 'https://www.ebay.ca/usr/someseller' },
    shipping: { price: 'C $7.95', service: 'Canada Post', location: 'Toronto, Canada' },
  };
}

function notFoundBody(credits: Credits = {}): Record<string, unknown> {
  return {
    request_info: requestInfo(credits),
    request_metadata: metadata('https://www.ebay.ca/itm/999999999999?_fcid=2'),
    message: 'Product not found.',
  };
}

function sellerBody(credits: Credits = {}): Record<string, unknown> {
  return {
    request_info: requestInfo(credits),
    request_metadata: metadata('https://www.ebay.ca/usr/tweedsidesales?_fcid=2'),
    seller: { name: 'Jeremy Doherty', link: 'https://www.ebay.ca/str/jeremydoherty', positive_ratings_percent: 99.8, followers: '79 followers' },
  };
}

function config(overrides: Partial<CountdownConfig> = {}): CountdownConfig {
  return {
    apiKey: API_KEY,
    baseUrl: 'https://api.countdownapi.com',
    creditReserve: 50,
    maxConcurrency: 4,
    timeoutMs: 5_000,
    destinations: {
      toronto: { customerLocation: 'ca', customerZipcode: 'M6H2W9' },
      forwarder: { customerLocation: 'us', customerZipcode: '34249' },
    },
    ...overrides,
  };
}

function build(responder: Responder, overrides: Partial<CountdownConfig> = {}, extra: Pick<CountdownSourceOptions, 'now'> = {}) {
  const store = new MemoryStore();
  const vendor = stubVendor(responder);
  const source = new CountdownSource({ config: config(overrides), store, fetchImpl: vendor.impl, retryDelaysMs: [], ...extra });
  return { source, store, calls: vendor.calls };
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'countdown');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

/** Just enough of McpServer to capture the handlers registerSourceTools installs. */
function fakeServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  return { server: server as unknown as McpServer, tools };
}

function errorPayload(result: Awaited<ReturnType<ToolHandler>>): { code: string; message: string; retryable: boolean; details: Record<string, unknown> } {
  return (JSON.parse(result.content[0]!.text) as { error: { code: string; message: string; retryable: boolean; details: Record<string, unknown> } }).error;
}

const search = (input: Record<string, unknown>) => EbayApiSearchInput.parse(input);
const items = (input: Record<string, unknown>) => EbayApiItemsInput.parse(input);
const seller = (input: Record<string, unknown>) => EbayApiSellerInput.parse(input);

async function failure(promise: Promise<unknown>): Promise<BridgeError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    return err as BridgeError;
  }
  throw new Error('expected the call to fail');
}

/** Route a stub by the vendor request type, with a per-type credit report; the free account endpoint reports the same balance. */
function routed(credits: Credits = {}): Responder {
  return ({ url, query }) => {
    if (url.pathname === '/account') {
      return json({
        request_info: { success: true },
        account_info: {
          credits_used: credits.used === undefined ? 10 : credits.used,
          credits_remaining: credits.remaining === undefined ? 990 : credits.remaining,
        },
      });
    }
    const type = query.get('type');
    if (type === 'search') return json(searchBody([searchRow('111111111111', 20)], credits));
    if (type === 'product') return json(productBody(/\/itm\/(\d+)/.exec(query.get('url') ?? '')?.[1] ?? '000000000000', credits));
    if (type === 'seller_profile') return json(sellerBody(credits));
    return json({ request_info: { success: false, message: 'unexpected type' } }, 400);
  };
}

describe('credit reserve gate (§2 Credits)', () => {
  it('refuses search and items once the last reported balance is below the reserve, and still serves a seller lookup', async () => {
    const { source, calls } = build(routed({ remaining: 40 }));
    expect(source.creditsRemaining).toBeNull();

    // Unknown balance never blocks: the first call is how it becomes known.
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(calls).toHaveLength(1);
    expect(source.creditsRemaining).toBe(40);

    const refusedSearch = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(refusedSearch.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(refusedSearch.retryable).toBe(false);
    expect(refusedSearch.details).toMatchObject({ creditsRemaining: 40, creditReserve: 50, kind: 'search' });
    // The refusal first re-reads the free account balance (no credit
    // spent), which still says 40; the search itself never goes out.
    expect(calls.map((call) => call.url.pathname)).toEqual(['/request', '/account']);

    const refusedItems = await failure(source.items(items({ items: [{ itemId: '123456789012' }] })));
    expect(refusedItems.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    // Inside a minute of that probe the memory is trusted outright.
    expect(calls).toHaveLength(2);

    const profile = await source.seller(seller({ loginId: 'tweedsidesales' }));
    expect(profile.resolved).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.query.get('type')).toBe('seller_profile');
  });

  it('a balance at the reserve is still allowed, and a vendor that reports no balance never blocks', async () => {
    const atReserve = build(routed({ remaining: 50 }));
    await atReserve.source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    await atReserve.source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(atReserve.calls).toHaveLength(2);

    const unknown = build(routed({ used: null, remaining: null }));
    await unknown.source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    await unknown.source.items(items({ items: [{ itemId: '123456789012' }] }));
    expect(unknown.source.creditsRemaining).toBeNull();
    expect(unknown.calls).toHaveLength(2);
  });

  it('a vendor 402 is remembered as an empty balance, so the next search is refused without a charged request', async () => {
    const { source, calls } = build(() => json({ request_info: { success: false, message: 'Out of credits' } }, 402));
    const first = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(first.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(calls).toHaveLength(1);
    expect(source.creditsRemaining).toBe(0);
    // The refusal asks the free account endpoint once (which answers 402
    // too, so the memory stands) and never re-issues the search.
    const second = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(second.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(calls.map((call) => call.url.pathname)).toEqual(['/request', '/account']);
    expect(source.creditsRemaining).toBe(0);
    const third = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(third.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(calls).toHaveLength(2);
  });

  it('keeps the newest balance when parallel responses land out of order', async () => {
    const { source } = build(async ({ query }) => {
      if (query.get('listing_type') === 'buy_it_now') {
        // The older figure (fewer credits used, more remaining) answers last.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return json(searchBody([searchRow('111111111111', 20)], { used: 10, remaining: 501 }));
      }
      return json(searchBody([searchRow('333333333333', 1)], { used: 11, remaining: 499 }));
    });
    const result = await source.search(search({ searchTerm: 'lego' }));
    expect(result.credits).toEqual({ used: 11, remaining: 499 });
    expect(source.creditsRemaining).toBe(499);
  });

  it('accepts a balance only from a response at least as far along as the last accepted one', async () => {
    const reports: Credits[] = [
      { used: 20, remaining: 480 },
      { used: 15, remaining: 485 },
      { used: null, remaining: 470 },
    ];
    const { source } = build((_call, ordinal) => json(searchBody([searchRow('111111111111', 20)], reports[ordinal - 1] ?? {})));
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(source.creditsRemaining).toBe(480);
    // A stale response (used 15 < 20) cannot move the memory.
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(source.creditsRemaining).toBe(480);
    // One that does not say how far along it is is taken at its word.
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(source.creditsRemaining).toBe(470);
  });

  it('re-reads the free account balance before refusing, and reopens the gate after a top-up', async () => {
    let clock = Date.parse('2026-09-02T18:00:00Z');
    let vendorRemaining = 40;
    const { source, store, calls } = build(
      ({ url }) => {
        if (url.pathname === '/account') {
          return json({ request_info: { success: true }, account_info: { credits_used: 960, credits_remaining: vendorRemaining } });
        }
        return json(searchBody([searchRow('111111111111', 20)], { used: 960, remaining: vendorRemaining }));
      },
      {},
      { now: () => new Date(clock) },
    );
    const paths = () => calls.map((call) => call.url.pathname);

    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(source.creditsRemaining).toBe(40);

    // Below the reserve: the free endpoint is asked once, and the call is
    // still refused because nothing changed. No charged request went out.
    const refused = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(refused.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(paths()).toEqual(['/request', '/account']);
    expect(calls[1]!.query.get('api_key')).toBe(API_KEY);

    // Inside a minute the memory is trusted: no second probe, no request.
    clock += 30_000;
    const stillRefused = await failure(source.items(items({ items: [{ itemId: '123456789012' }] })));
    expect(stillRefused.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(paths()).toEqual(['/request', '/account']);

    // A top-up lands; a minute on, the gate asks again and reopens.
    vendorRemaining = 900;
    clock += 31_000;
    const served = await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths()).toEqual(['/request', '/account', '/account', '/request']);
    expect(served.credits.remaining).toBe(900);
    expect(source.creditsRemaining).toBe(900);

    // The probe is an upstream call like any other: an audit row each, key-free.
    const probes = store.audit.events.filter((event) => (event.metadata as { requestType?: unknown } | null | undefined)?.requestType === 'account');
    expect(probes).toHaveLength(2);
    expect(probes.every((event) => event.outcome === 'ok' && event.actionClass === 'source')).toBe(true);
    expect(JSON.stringify(probes)).not.toContain(API_KEY);
  });
});

describe('named destinations (§2 Destinations)', () => {
  it('sends the Toronto postal code on a toronto search and the forwarder suite on a forwarder search', async () => {
    const { source, calls } = build(routed());
    await source.search(search({ searchTerm: 'lego', listingType: 'auction', destination: 'toronto' }));
    expect(calls[0]!.query.get('customer_location')).toBe('ca');
    expect(calls[0]!.query.get('customer_zipcode')).toBe('M6H2W9');

    await source.search(search({ searchTerm: 'lego', listingType: 'auction', destination: 'forwarder', domain: 'ebay.com' }));
    expect(calls[1]!.query.get('customer_location')).toBe('us');
    expect(calls[1]!.query.get('customer_zipcode')).toBe('34249');
    expect(calls[1]!.query.get('ebay_domain')).toBe('ebay.com');
  });

  it('sends no location at all under domain_default', async () => {
    const { source, calls } = build(routed());
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(calls[0]!.query.has('customer_location')).toBe(false);
    expect(calls[0]!.query.has('customer_zipcode')).toBe(false);
    await source.items(items({ items: [{ itemId: '123456789012' }] }));
    expect(calls[1]!.query.has('customer_location')).toBe(false);
    expect(calls[1]!.query.has('customer_zipcode')).toBe(false);
  });

  it('never sends a zip on a product request, whatever the destination', async () => {
    const { source, calls } = build(routed());
    await source.items(items({ items: [{ itemId: '123456789012' }], destination: 'toronto' }));
    await source.items(items({ items: [{ itemId: '123456789012' }], destination: 'forwarder' }));
    for (const call of calls) {
      expect(call.query.get('type')).toBe('product');
      expect(call.query.has('customer_zipcode')).toBe(false);
    }
    expect(calls[0]!.query.get('customer_location')).toBe('ca');
    expect(calls[1]!.query.get('customer_location')).toBe('us');
  });

  it('normalises the configured postal code to uppercase with no whitespace before sending it', async () => {
    const { source, calls } = build(routed(), {
      destinations: {
        toronto: { customerLocation: 'ca', customerZipcode: 'm6h 2w9' },
        forwarder: { customerLocation: 'us', customerZipcode: '34249' },
      },
    });
    await source.search(search({ searchTerm: 'lego', listingType: 'auction', destination: 'toronto' }));
    expect(calls[0]!.query.get('customer_zipcode')).toBe('M6H2W9');
  });

  it('the key rides only in the outbound query string', async () => {
    const { source, store, calls } = build(routed());
    const result = await source.search(search({ searchTerm: 'lego', listingType: 'auction', destination: 'toronto' }));
    expect(calls[0]!.query.get('api_key')).toBe(API_KEY);
    expect(calls[0]!.url.origin).toBe('https://api.countdownapi.com');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(store.audit.events)).not.toContain(API_KEY);
    expect(JSON.stringify(store.audit.events)).not.toContain('api_key=');
  });
});

describe('split search (§3.1)', () => {
  const twoSets: Responder = ({ query }) => {
    const listingType = query.get('listing_type');
    if (listingType === 'buy_it_now') {
      return json(searchBody([searchRow('111111111111', 20), searchRow('222222222222', 30)], { used: 11, remaining: 989 }, 2));
    }
    if (listingType === 'auction') {
      return json(searchBody([searchRow('222222222222', 5), searchRow('333333333333', 1)], { used: 12, remaining: 988 }, 2));
    }
    return json({ request_info: { success: false, message: 'unfiltered search issued' } }, 400);
  };

  it("listingType 'all' is exactly two filtered vendor requests merged by item id, never an unfiltered one", async () => {
    const { source, calls } = build(twoSets);
    const result = await source.search(search({ searchTerm: 'lego minifigure lot' }));
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.query.get('listing_type')).sort()).toEqual(['auction', 'buy_it_now']);
    expect(calls.every((call) => call.query.get('search_term') === 'lego minifigure lot')).toBe(true);

    expect(EbayApiSearchOutput.parse(result)).toBeTruthy();
    expect(result.retrievedUnder).toEqual(['buy_it_now', 'auction']);
    expect(result.candidateCount).toBe(3);
    const formats = new Map(result.candidates.map((candidate) => [candidate.itemId, candidate.sellingFormat]));
    expect(formats.get('111111111111')).toBe('fixed_price');
    expect(formats.get('222222222222')).toBe('auction_with_bin');
    expect(formats.get('333333333333')).toBe('auction');
    // Both filters' totals, both request ids, the latest balance.
    expect(result.totalResults).toBe(4);
    expect(result.requestIds).toHaveLength(2);
    expect(result.credits).toEqual({ used: 12, remaining: 988 });
    expect(result.pagesFetched).toBe(1);
    expect(result.hasNextPage).toBe(false);
    expect(result.warnings.some((warning) => warning.startsWith('BID_COUNT_UNAVAILABLE_FROM_SOURCE:'))).toBe(true);
    // The API default field set carries the zip-scoped shipping figure.
    expect(result.candidates[0]).toMatchObject({ shippingCost: 9.99, priceRange: false, condition: 'Pre-Owned' });
  });

  it('any other listing type is one request retrieved under that filter', async () => {
    const { source, calls } = build(twoSets);
    const result = await source.search(search({ searchTerm: 'lego', listingType: 'auction', sortBy: 'newly_listed' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query.get('listing_type')).toBe('auction');
    expect(calls[0]!.query.get('sort_by')).toBe('newly_listed');
    expect(result.retrievedUnder).toEqual(['auction']);
    expect(result.candidates.every((candidate) => candidate.sellingFormat === 'auction')).toBe(true);
  });

  it('a url search gets its listing filter in the query string, because the vendor ignores listing_type beside url', async () => {
    const byUrl: Responder = ({ query }) => {
      const target = new URL(query.get('url') ?? 'https://invalid.example/');
      if (target.searchParams.get('LH_BIN') === '1') return json(searchBody([searchRow('111111111111', 20)]));
      if (target.searchParams.get('LH_Auction') === '1') return json(searchBody([searchRow('333333333333', 1)]));
      return json({ request_info: { success: false, message: 'unfiltered url search issued' } }, 400);
    };
    const { source, calls } = build(byUrl);
    const result = await source.search(
      search({ url: 'https://www.ebay.ca/sch/i.html?_ssn=tweedsidesales&_nkw=lego&_sop=10&_ipg=240', destination: 'toronto' }),
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !call.query.has('listing_type') && !call.query.has('search_term'))).toBe(true);
    const targets = calls.map((call) => new URL(call.query.get('url')!));
    expect(targets.every((target) => target.searchParams.get('_ssn') === 'tweedsidesales' && target.searchParams.get('_ipg') === '240')).toBe(true);
    expect(targets.map((target) => target.searchParams.has('LH_BIN')).sort()).toEqual([false, true]);
    expect(targets.map((target) => target.searchParams.has('LH_Auction')).sort()).toEqual([false, true]);
    expect(result.domain).toBe('ebay.ca');
    expect(result.retrievedUnder).toEqual(['buy_it_now', 'auction']);
    expect(result.candidateCount).toBe(2);
  });

  it('a url that already carries LH_Auction=1 is one auction request passed through verbatim', async () => {
    const { source, calls } = build(() => json(searchBody([searchRow('333333333333', 1)])));
    const url = 'https://www.ebay.com/sch/i.html?_nkw=lego+printed+tiles&LH_Auction=1&_sop=10';
    const result = await source.search(search({ url, destination: 'forwarder' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query.get('url')).toBe(url);
    expect(calls[0]!.query.get('customer_zipcode')).toBe('34249');
    expect(result.domain).toBe('ebay.com');
    expect(result.retrievedUnder).toEqual(['auction']);
  });

  it('scans every merged row: an auction filter finds the auction-only tail of two 240-row pages', async () => {
    const binPage = fixture('keyed/search-ca-lego-minifig-newly-listed.json');
    const auctionPage = fixture('keyed/search-ca-lego-minifig-auction-newly-listed.json');
    const { source } = build(({ query }) => {
      const listingType = query.get('listing_type');
      if (listingType === 'buy_it_now') return json(binPage);
      if (listingType === 'auction') return json(auctionPage);
      return json({ request_info: { success: false, message: 'unfiltered search issued' } }, 400);
    });
    const term = { searchTerm: 'lego minifigure lot', sortBy: 'newly_listed', destination: 'toronto' };

    // 240 + 240 rows with the measured 30-id overlap merge to 450, the
    // auction-only rows last; under the compactor's 240-row scan cap none
    // of them was ever seen.
    const auctions = await source.search(search({ ...term, search: { include: { formats: ['auction'] } } }));
    expect(auctions.candidateCount).toBe(450);
    expect(auctions.candidates).toHaveLength(210);
    expect(auctions.candidates.every((candidate) => candidate.sellingFormat === 'auction')).toBe(true);
    expect(auctions.hasMore).toBe(false);
    expect(auctions.warnings.some((warning) => warning.startsWith('CANDIDATES_TRUNCATED:'))).toBe(false);

    // The API default window is a whole page, and paging past it is said
    // out loud because an offset page re-issues both vendor requests.
    const whole = await source.search(search(term));
    expect(whole.candidates).toHaveLength(240);
    expect(whole).toMatchObject({ offset: 0, hasMore: true, nextOffset: 240 });
    expect(whole.warnings).toContain(
      'OFFSET_PAGING_REISSUES_REQUESTS: paging with search.offset re-issues the vendor requests and spends credits again; raise search.limit instead',
    );
    const kinds = new Map<unknown, number>();
    for (const candidate of whole.candidates) kinds.set(candidate.sellingFormat, (kinds.get(candidate.sellingFormat) ?? 0) + 1);
    expect(kinds.get('fixed_price')).toBe(210);
    expect(kinds.get('auction_with_bin')).toBe(30);

    const tail = await source.search(search({ ...term, search: { offset: 240 } }));
    expect(tail.candidates).toHaveLength(210);
    expect(tail.candidates.every((candidate) => candidate.sellingFormat === 'auction')).toBe(true);
    expect(tail).toMatchObject({ offset: 240, hasMore: false, nextOffset: null });
    expect(tail.warnings.some((warning) => warning.startsWith('OFFSET_PAGING_REISSUES_REQUESTS:'))).toBe(false);
  });
});

describe('item pool (§3.2)', () => {
  const ITEM_IDS = ['100000000001', '100000000002', '100000000003', '100000000004', '100000000005'];

  it('keeps slot order with concurrency 2 over 5 items whose responses resolve out of order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { source, calls } = build(async ({ query }) => {
      const itemId = /\/itm\/(\d+)/.exec(query.get('url') ?? '')![1]!;
      const index = ITEM_IDS.indexOf(itemId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Later items answer sooner, so completion order is the reverse of dispatch order within each pair.
      await new Promise((resolve) => setTimeout(resolve, (index % 2 === 0 ? 30 : 5)));
      inFlight -= 1;
      return json(productBody(itemId));
    }, { maxConcurrency: 2 });

    const result = await source.items(items({ items: ITEM_IDS.map((itemId) => ({ itemId })), destination: 'toronto' }));
    expect(calls).toHaveLength(5);
    expect(maxInFlight).toBe(2);
    expect(EbayApiItemsOutput.parse(result)).toBeTruthy();
    expect(result).toMatchObject({ mode: 'inline', jobId: null, status: 'completed', requested: 5, completed: 5, succeeded: 5, failed: 0, compact: true, resultsFrom: 0 });
    expect(result.results.map((slot) => slot.url)).toEqual(ITEM_IDS.map((itemId) => `https://www.ebay.ca/itm/${itemId}`));
    for (const [index, slot] of result.results.entries()) {
      expect(slot.ok).toBe(true);
      expect(slot.siteProfile).toBe('ebay.api.v1');
      expect(slot.pageRevision).toBe(0);
      expect((slot.record as { itemId: string }).itemId).toBe(ITEM_IDS[index]);
      expect(slot.finalUrl).toBe(`https://www.ebay.ca/itm/${ITEM_IDS[index]}?_fcid=2`);
      expect(slot.warnings.some((warning) => warning.startsWith('DESTINATION_UNVERIFIED:'))).toBe(true);
      expect(slot.error).toBeNull();
    }
    expect(result.requestIds).toHaveLength(5);
    const { source: _source, credits: _credits, requestIds: _requestIds, ...bridgeShape } = result;
    expect(ExtractManyOutput.parse(bridgeShape)).toBeTruthy();
  });

  it('a per-item vendor error lands in its own slot and never fails the batch', async () => {
    const { source, store, calls } = build(({ query }) => {
      const itemId = /\/itm\/(\d+)/.exec(query.get('url') ?? '')![1]!;
      if (itemId === ITEM_IDS[1]) return json({ request_info: { success: false, message: 'Invalid url' } }, 400);
      if (itemId === ITEM_IDS[2]) return json(notFoundBody());
      return json(productBody(itemId));
    });
    const result = await source.items(items({ items: ITEM_IDS.slice(0, 3).map((itemId) => ({ itemId })) }));
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ status: 'completed', requested: 3, completed: 3, succeeded: 1, failed: 2 });

    expect(result.results[0]!.ok).toBe(true);

    const rejected = result.results[1]!;
    expect(rejected.ok).toBe(false);
    expect(rejected.record).toBeNull();
    expect(rejected.error).toMatchObject({ code: 'SOURCE_REJECTED', retryable: false });
    expect(rejected.error!.message).not.toContain(API_KEY);

    // A dead listing keeps its record as evidence but is never ok.
    const unavailable = result.results[2]!;
    expect(unavailable.ok).toBe(false);
    expect(unavailable.record).not.toBeNull();
    expect((unavailable.record as { listingStatus: string }).listingStatus).toBe('unavailable');
    expect(unavailable.error).toMatchObject({ code: 'LISTING_UNAVAILABLE', retryable: false });
    expect(unavailable.error!.message).toMatch(/Product not found/);

    // One audit row per upstream call, shaped like the broker's, key-free.
    const rows = store.audit.events.filter((event) => event.toolName === 'ebay_api_items');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.outcome).sort()).toEqual(['error', 'ok', 'ok']);
    expect(rows.find((row) => row.outcome === 'error')?.errorCode).toBe('SOURCE_REJECTED');
    for (const row of rows) {
      expect(row.actionClass).toBe('source');
      expect(row.deviceId).toBeNull();
      expect(row.metadata).toMatchObject({ source: 'countdown', requestType: 'product' });
      expect(JSON.stringify(row)).not.toContain(API_KEY);
      expect(JSON.stringify(row)).not.toContain('countdownapi.com/request?');
    }
    expect(rows.filter((row) => row.outcome === 'ok').every((row) => typeof row.requestId === 'string')).toBe(true);
  });

  it('a reserve crossed mid-batch refuses the remaining slots instead of the batch', async () => {
    const { source, calls } = build(
      ({ url, query }) => {
        if (url.pathname === '/account') return json({ request_info: { success: true }, account_info: { credits_used: 10, credits_remaining: 49 } });
        return json(productBody(/\/itm\/(\d+)/.exec(query.get('url') ?? '')![1]!, { remaining: 49 }));
      },
      { maxConcurrency: 1 },
    );
    const result = await source.items(items({ items: ITEM_IDS.slice(0, 3).map((itemId) => ({ itemId })) }));
    // One charged request: the slot that found the reserve crossed re-read
    // the free balance once, and the last slot trusted that reading.
    expect(calls.map((call) => call.url.pathname)).toEqual(['/request', '/account']);
    expect(result).toMatchObject({ status: 'completed', requested: 3, completed: 3, succeeded: 1, failed: 2 });
    expect(result.results[0]!.ok).toBe(true);
    expect(result.results[1]!.error?.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(result.results[2]!.error?.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(result.warnings.some((warning) => warning.startsWith('SOURCE_CREDITS_EXHAUSTED:'))).toBe(true);
    expect(result.credits).toEqual({ used: 10, remaining: 49 });
  });

  it('serves the full provenance record when compact is false and takes the domain from an item url', async () => {
    const { source, calls } = build(({ query }) => json(productBody(/\/itm\/(\d+)/.exec(query.get('url') ?? '')![1]!)));
    const result = await source.items(
      items({ items: [{ url: 'https://www.ebay.com/itm/167665350336', expectedFormat: 'fixed_price' }], compact: false }),
    );
    expect(calls[0]!.query.get('url')).toBe('https://www.ebay.com/itm/167665350336');
    const record = result.results[0]!.record as { siteProfile: string; itemPrice: { source: string } | null; sellingFormat: { kind: string } };
    expect(record.siteProfile).toBe('ebay.api.v1');
    expect(record.itemPrice?.source).toBe('api');
    expect(record.sellingFormat.kind).toBe('fixed_price');
    expect(result.compact).toBe(false);
  });

  it('issues no vendor request once the deadline flag is set: untouched slots are SOURCE_UNAVAILABLE and the batch is partial', async () => {
    const deadline: SourceDeadline = { deadlineMs: 50, expired: false };
    const { source, calls } = build(({ query }) => {
      // The deadline passes while the first request is in flight.
      deadline.expired = true;
      return json(productBody(/\/itm\/(\d+)/.exec(query.get('url') ?? '')![1]!));
    }, { maxConcurrency: 1 });
    const result = await source.items(items({ items: ITEM_IDS.slice(0, 3).map((itemId) => ({ itemId })) }), undefined, deadline);
    expect(calls).toHaveLength(1);
    expect(EbayApiItemsOutput.parse(result)).toBeTruthy();
    expect(result).toMatchObject({ status: 'partial', requested: 3, completed: 1, succeeded: 1, failed: 0 });
    expect(result.results).toHaveLength(3);
    expect(result.results[0]!.ok).toBe(true);
    for (const slot of result.results.slice(1)) {
      expect(slot).toMatchObject({ ok: false, record: null, finalUrl: null, error: { code: 'SOURCE_UNAVAILABLE', retryable: true } });
      expect(slot.error!.message).toMatch(/deadline of 50 ms/);
    }
    expect(result.warnings.some((warning) => warning.startsWith('BATCH_DEADLINE_REACHED:'))).toBe(true);
    const { source: _source, credits: _credits, requestIds: _requestIds, ...bridgeShape } = result;
    expect(ExtractManyOutput.parse(bridgeShape)).toBeTruthy();
  });
});

describe('seller lookup (§3.3)', () => {
  it('builds the /usr/ URL from a login id and maps the profile', async () => {
    const { source, calls } = build(routed({ used: 3, remaining: 97 }));
    const result = await source.seller(seller({ loginId: 'tweedsidesales' }));
    expect(calls[0]!.query.get('type')).toBe('seller_profile');
    expect(calls[0]!.query.get('url')).toBe('https://www.ebay.ca/usr/tweedsidesales');
    expect(EbayApiSellerOutput.parse(result)).toBeTruthy();
    expect(result.resolved).toBe(true);
    expect(result.seller).toMatchObject({
      name: 'Jeremy Doherty',
      loginId: 'tweedsidesales',
      storeSlug: 'jeremydoherty',
      profileUrl: 'https://www.ebay.ca/usr/tweedsidesales',
      positivePercent: 99.8,
      followers: '79 followers',
    });
    expect(result.credits).toEqual({ used: 3, remaining: 97 });
    expect(result.requestIds).toHaveLength(1);
  });

  it('reports resolved:false with the vendor message when no seller block comes back', async () => {
    const { source } = build(() => json({ request_info: requestInfo(), request_metadata: metadata('https://www.ebay.ca/usr/nobody'), message: 'Seller not found.' }));
    const result = await source.seller(seller({ url: 'https://www.ebay.ca/usr/nobody' }));
    expect(result.resolved).toBe(false);
    expect(result.seller).toBeNull();
    expect(result.warnings.some((warning) => warning.startsWith('SELLER_UNRESOLVED:') && warning.includes('Seller not found.'))).toBe(true);
  });
});

describe('tool deadline (catalog timeoutMs, enforced by registerSourceTools)', () => {
  const READ = { scopes: ['browser:read'], clientId: 'unit' };

  it('a vendor that never answers cannot hold the call open past the deadline', async () => {
    const { source } = build(() => new Promise<Response>(() => {}));
    const { server, tools } = fakeServer();
    registerSourceTools(server, source, READ, { timeoutMs: 30 });
    expect([...tools.keys()]).toEqual(['ebay_api_search', 'ebay_api_items', 'ebay_api_seller']);

    const result = await tools.get('ebay_api_search')!({ searchTerm: 'lego', listingType: 'auction' });
    expect(result.isError).toBe(true);
    expect(errorPayload(result)).toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      retryable: true,
      message: 'tool deadline of 30 ms exceeded',
      details: { deadlineMs: 30 },
    });
  });

  it('answers SOURCE_UNAVAILABLE when the deadline passes mid-batch, and the pool issues nothing afterwards', async () => {
    let held = false;
    const { source, calls } = build(async ({ query }) => {
      const itemId = /\/itm\/(\d+)/.exec(query.get('url') ?? '')![1]!;
      // The first request outlives the 40 ms deadline; any later one would answer at once.
      if (!held) {
        held = true;
        await new Promise((resolve) => setTimeout(resolve, 90));
      }
      return json(productBody(itemId));
    }, { maxConcurrency: 1 });
    const { server, tools } = fakeServer();
    registerSourceTools(server, source, READ, { timeoutMs: 40 });

    const result = await tools.get('ebay_api_items')!({
      items: [{ itemId: '100000000001' }, { itemId: '100000000002' }, { itemId: '100000000003' }],
    });
    expect(result.isError).toBe(true);
    expect(errorPayload(result)).toMatchObject({ code: 'SOURCE_UNAVAILABLE', message: 'tool deadline of 40 ms exceeded', details: { deadlineMs: 40 } });

    // Once the held request answers, the pool reads the flag and stops: one vendor call, ever.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toHaveLength(1);
  });

  it('a call inside its deadline is unaffected', async () => {
    const { source } = build(routed());
    const { server, tools } = fakeServer();
    registerSourceTools(server, source, READ, { timeoutMs: 5_000 });
    const result = await tools.get('ebay_api_seller')!({ loginId: 'tweedsidesales' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ resolved: true });
  });
});

describe('input pre-screen (§2 URL policy at the tool layer)', () => {
  const caller = { subject: null, traceparent: null };

  it('names the reason and ORIGIN_DENIED for a refused url on every tool, before the schema and before any vendor call', async () => {
    const { source, calls } = build(routed());

    // An item url is one branch of a union, whose failure the schema reports
    // as "invalid input" at items.N with no reason: this used to be ACTION_BLOCKED.
    const item = await failure(
      runSourceTool(source, 'ebay_api_items', { items: [{ itemId: '123456789012' }, { url: 'https://attacker.example/itm/123456789012' }] }, caller),
    );
    expect(item.code).toBe('ORIGIN_DENIED');
    expect(item.message).toMatch(/host attacker\.example/);
    expect(item.details).toMatchObject({ url: 'https://attacker.example/itm/123456789012', path: 'items.1.url', tool: 'ebay_api_items' });

    const smuggled = await failure(runSourceTool(source, 'ebay_api_search', { url: 'https://www.ebay.ca\\itm\\123456789012@evil.com/' }, caller));
    expect(smuggled.code).toBe('ORIGIN_DENIED');
    expect(smuggled.message).toMatch(/backslash/);

    const profile = await failure(runSourceTool(source, 'ebay_api_seller', { url: 'https://www.ebay.ca/itm/123456789012' }, caller));
    expect(profile.code).toBe('ORIGIN_DENIED');
    expect(profile.message).toMatch(/path/);
    expect(calls).toHaveLength(0);

    // The schema stays the second line: a malformed input with no url to
    // blame is still a blocked call, and an accepted url still runs.
    const blocked = await failure(runSourceTool(source, 'ebay_api_items', { items: [{ expectedFormat: 'auction' }] }, caller));
    expect(blocked.code).toBe('ACTION_BLOCKED');
    expect(calls).toHaveLength(0);
    const served = await runSourceTool(source, 'ebay_api_seller', { url: 'https://www.ebay.ca/usr/tweedsidesales' }, caller);
    expect(served.resolved).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
