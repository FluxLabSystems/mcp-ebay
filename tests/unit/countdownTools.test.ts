/**
 * CountdownSource — docs/COUNTDOWN-API-PLAN.md §2, §6.5 and §6.6: the
 * credit reserve gate and the account probe behind it, the status tool, the
 * named-destination mapping, the split search, the bounded item pool with
 * per-slot failure and the tool deadline, all against a stub vendor with no
 * gateway on the path.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import type { CountdownConfig } from '@browser-bridge/config';
import {
  CountdownSource,
  CREDIT_PROBE_MIN_INTERVAL_MS,
  CREDIT_PROBE_TIMEOUT_MS,
  MemoryStore,
  registerSourceTools,
  runSourceTool,
  startDeadline,
  SUSPENSION_COOLDOWN_MS,
  type CountdownSourceOptions,
} from '@browser-bridge/gateway';
import {
  BridgeError,
  EbayApiItemsInput,
  EbayApiItemsOutput,
  EbayApiSearchInput,
  EbayApiSearchOutput,
  EbayApiSellerInput,
  EbayApiSellerOutput,
  EbayApiStatusOutput,
  ExtractManyOutput,
} from '@browser-bridge/protocol';

const API_KEY = 'cd-unit-SECRET-key';

interface VendorCall {
  url: URL;
  query: URLSearchParams;
  init: RequestInit | undefined;
}

type Responder = (call: VendorCall, ordinal: number) => Response | Promise<Response>;

function stubVendor(responder: Responder): { impl: typeof fetch; calls: VendorCall[] } {
  const calls: VendorCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const call = { url, query: url.searchParams, init };
    calls.push(call);
    return responder(call, calls.length);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The charged requests among the vendor calls: everything the gate's free account probes are not. */
function requests(calls: readonly VendorCall[]): VendorCall[] {
  return calls.filter((call) => call.url.pathname === '/request');
}

function paths(calls: readonly VendorCall[]): string[] {
  return calls.map((call) => call.url.pathname);
}

/** A fetch that never answers on its own and fails the way undici does when its signal aborts. */
function hanging(onAbort?: () => void): Responder {
  return ({ init }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return;
      const fail = () => {
        onAbort?.();
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'));
      };
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
}

interface Credits {
  used?: number | null;
  remaining?: number | null;
  /** credits_used_this_request; null makes the stub omit the figure the way a nulled capture does. */
  usedThisRequest?: number | null;
}

function requestInfo(credits: Credits = {}): Record<string, unknown> {
  return {
    success: true,
    credits_used: credits.used === undefined ? 10 : credits.used,
    credits_remaining: credits.remaining === undefined ? 990 : credits.remaining,
    credits_used_this_request: credits.usedThisRequest === undefined ? 1 : credits.usedThisRequest,
  };
}

let requestSeq = 0;
function metadata(ebayUrl: string): Record<string, unknown> {
  requestSeq += 1;
  return { id: `req_${requestSeq}`, ebay_url: ebayUrl };
}

/** The free account endpoint's figures; every field has the stub's default and `null` makes the vendor omit it. */
interface AccountStub {
  plan?: string | null;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
}

function accountBody(stub: AccountStub = {}): Record<string, unknown> {
  return {
    request_info: { success: true },
    request_metadata: { id: `acct_${(requestSeq += 1)}` },
    // The vendor echoes the account's key and email; nothing downstream may.
    account_info: {
      api_key: API_KEY,
      name: 'Unit Test',
      email: 'unit@example.com',
      plan: stub.plan === undefined ? 'starter' : stub.plan,
      credits_used: stub.used === undefined ? 10 : stub.used,
      credits_limit: stub.limit === undefined ? 10_000 : stub.limit,
      credits_remaining: stub.remaining === undefined ? 990 : stub.remaining,
      credits_reset_at: stub.resetAt === undefined ? '2026-10-01T00:00:00Z' : stub.resetAt,
    },
  };
}

/** The trial account the first fire ran on: a one-time 100, 82 left. */
const TRIAL: AccountStub = { plan: 'free', limit: 100, used: 18, remaining: 82, resetAt: null };

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

const ABSOLUTE_50: CountdownConfig['creditReserve'] = { kind: 'absolute', credits: 50, configured: '50' };
const ABSOLUTE_500: CountdownConfig['creditReserve'] = { kind: 'absolute', credits: 500, configured: '500' };
const PERCENT_5: CountdownConfig['creditReserve'] = { kind: 'percent', percent: 5, configured: '5%' };

function config(overrides: Partial<CountdownConfig> = {}): CountdownConfig {
  return {
    apiKey: API_KEY,
    // The pre-2026-09-03 behaviour every gate test below was written
    // against; the role gate has its own describe block.
    role: 'primary',
    baseUrl: 'https://api.countdownapi.com',
    creditReserve: ABSOLUTE_50,
    maxConcurrency: 4,
    timeoutMs: 5_000,
    destinations: {
      toronto: { customerLocation: 'ca', customerZipcode: 'M6H2W9' },
      forwarder: { customerLocation: 'us', customerZipcode: '34249' },
    },
    ...overrides,
  };
}

interface LogLine {
  fields: Record<string, unknown>;
  message: string;
}

/** Just enough of pino to see what the source says about the account. */
function fakeLogger(): { logger: Logger; lines: { info: LogLine[]; warn: LogLine[]; error: LogLine[] } } {
  const lines = { info: [] as LogLine[], warn: [] as LogLine[], error: [] as LogLine[] };
  const record = (level: keyof typeof lines) => (fields: Record<string, unknown>, message: string) => {
    lines[level].push({ fields, message });
  };
  const logger = { info: record('info'), warn: record('warn'), error: record('error') } as unknown as Logger;
  return { logger, lines };
}

type BuildExtra = Pick<CountdownSourceOptions, 'now' | 'buildSha' | 'batchReturnGuardMs' | 'logger' | 'probeTimeoutMs' | 'retryDelaysMs' | 'sleep'> & {
  /** What the free account endpoint reports; 'responder' routes /account to the test's own responder instead. */
  account?: AccountStub | 'responder';
};

function build(responder: Responder, overrides: Partial<CountdownConfig> = {}, extra: BuildExtra = {}) {
  const store = new MemoryStore();
  const { account = {}, ...options } = extra;
  const vendor = stubVendor((call, ordinal) =>
    call.url.pathname === '/account' && account !== 'responder' ? json(accountBody(account)) : responder(call, ordinal),
  );
  const source = new CountdownSource({ config: config(overrides), store, fetchImpl: vendor.impl, retryDelaysMs: [], ...options });
  return { source, store, calls: vendor.calls };
}

/** The vendor's 2026-09-03 suspension notice, verbatim from the fire's improvement report. */
const SUSPENSION_NOTICE =
  'Your account has been temporarily suspended as our systems detected multiple Free Trial accounts being active, or a disposable email address being used during signup. This suspension will automatically be removed when you subscribe to a Plan.';

function suspended402(): Response {
  return json({ request_info: { success: false, message: SUSPENSION_NOTICE } }, 402);
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

interface RegisteredTool {
  annotations?: Record<string, unknown>;
  description?: string;
}

/** Just enough of McpServer to capture the handlers and configs registerSourceTools installs. */
function fakeServer(): { server: McpServer; tools: Map<string, ToolHandler>; configs: Map<string, RegisteredTool> } {
  const tools = new Map<string, ToolHandler>();
  const configs = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, config: RegisteredTool, handler: ToolHandler) => {
      tools.set(name, handler);
      configs.set(name, config);
    },
  };
  return { server: server as unknown as McpServer, tools, configs };
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

/** Route a stub by the vendor request type, with a per-type credit report on every charged response. */
function routed(credits: Credits = {}): Responder {
  return ({ query }) => {
    const type = query.get('type');
    if (type === 'search') return json(searchBody([searchRow('111111111111', 20)], credits));
    if (type === 'product') return json(productBody(/\/itm\/(\d+)/.exec(query.get('url') ?? '')?.[1] ?? '000000000000', credits));
    if (type === 'seller_profile') return json(sellerBody(credits));
    return json({ request_info: { success: false, message: 'unexpected type' } }, 400);
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('credit reserve gate (§2 Credits)', () => {
  it('never spends on an unknown balance: the free account endpoint is read before the first charged request', async () => {
    // The 2026-09-03 restart: an empty memory, 82 credits, a 500 reserve —
    // and the old gate sent the first search straight upstream.
    const { source, calls } = build(routed({ remaining: 82 }), { creditReserve: ABSOLUTE_500 }, { account: { remaining: 82 } });
    expect(source.creditsRemaining).toBeNull();
    const refused = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(refused.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(refused.retryable).toBe(false);
    expect(refused.details).toEqual({
      gate: true,
      reason: 'below_reserve',
      kind: 'search',
      creditsRemaining: 82,
      creditsLimit: 10_000,
      plan: 'starter',
      creditReserve: 500,
      reserveConfigured: '500',
    });
    expect(refused.message).toBe(
      'Countdown API credit reserve reached: 82 credit(s) remain, below the reserve of 500; search calls are refused until the balance is topped up (seller lookups still run).',
    );
    // The probe, and nothing charged.
    expect(paths(calls)).toEqual(['/account']);
    expect(source.creditsRemaining).toBe(82);
    expect(source.creditsLimit).toBe(10_000);

    const refusedItems = await failure(source.items(items({ items: [{ itemId: '123456789012' }] })));
    expect(refusedItems.details).toMatchObject({ reason: 'below_reserve', kind: 'items' });
    // Inside a minute of that probe the memory is trusted outright.
    expect(paths(calls)).toEqual(['/account']);

    // Seller lookups are exempt, and cost no probe either.
    const profile = await source.seller(seller({ loginId: 'tweedsidesales' }));
    expect(profile.resolved).toBe(true);
    expect(paths(calls)).toEqual(['/account', '/request']);
    expect(calls[1]!.query.get('type')).toBe('seller_profile');
  });

  it('refuses search and items once the balance falls below the reserve, and still serves a seller lookup', async () => {
    const { source, calls } = build(routed({ remaining: 40 }), {}, { account: { remaining: 60 } });
    // Above the reserve at the probe: admitted; the charged response then reports 40.
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths(calls)).toEqual(['/account', '/request']);
    expect(source.creditsRemaining).toBe(40);

    const refusedSearch = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(refusedSearch.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(refusedSearch.details).toMatchObject({ creditsRemaining: 40, creditReserve: 50, kind: 'search', reason: 'below_reserve' });
    // The probe is a minute old at most, so the memory is trusted: no call at all.
    expect(paths(calls)).toEqual(['/account', '/request']);

    const refusedItems = await failure(source.items(items({ items: [{ itemId: '123456789012' }] })));
    expect(refusedItems.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(calls).toHaveLength(2);

    const profile = await source.seller(seller({ loginId: 'tweedsidesales' }));
    expect(profile.resolved).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.query.get('type')).toBe('seller_profile');
  });

  it('a balance at the reserve is still allowed; a vendor that reports no balance never blocks, and is asked again once a minute', async () => {
    const atReserve = build(routed({ remaining: 50 }), {}, { account: { remaining: 50 } });
    await atReserve.source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    await atReserve.source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths(atReserve.calls)).toEqual(['/account', '/request', '/request']);

    // Nothing the account or the responses say is a balance: the gate
    // admits by fallback and says so. The account is not asked more than
    // once a minute — a batch's per-slot re-checks share the one reading —
    // and is asked again once the minute has passed.
    let clock = Date.parse('2026-09-03T12:00:00Z');
    const unknown = build(routed({ used: null, remaining: null }), {}, { account: { used: null, remaining: null, limit: null, plan: null }, now: () => new Date(clock) });
    const first = await unknown.source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(first.warnings.filter((warning) => warning.startsWith('CREDIT_RESERVE_UNRESOLVED:'))).toEqual([
      "CREDIT_RESERVE_UNRESOLVED: the credit balance is unknown (no account read has answered yet); the 50 reserve cannot be applied to this call and the vendor's own 402 is the backstop",
    ]);
    clock += 1_000;
    const second = await unknown.source.items(items({ items: [{ itemId: '123456789012' }, { itemId: '123456789013' }] }));
    expect(second.warnings.some((warning) => warning.startsWith('CREDIT_RESERVE_UNRESOLVED:'))).toBe(true);
    expect(unknown.source.creditsRemaining).toBeNull();
    expect(paths(unknown.calls)).toEqual(['/account', '/request', '/request', '/request']);
    clock += CREDIT_PROBE_MIN_INTERVAL_MS;
    await unknown.source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths(unknown.calls)).toEqual(['/account', '/request', '/request', '/request', '/account', '/request']);
  });

  it('a vendor 402 on a charged request is remembered as an empty balance, so the next search is refused without a charged request', async () => {
    const { source, calls } = build(() => json({ request_info: { success: false, message: 'Out of credits' } }, 402), {}, { account: { remaining: 60 } });
    const first = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(first.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(paths(calls)).toEqual(['/account', '/request']);
    expect(source.creditsRemaining).toBe(0);
    // The probe is fresh, so the refusal is answered from memory twice over.
    const second = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(second.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(second.details).toMatchObject({ reason: 'below_reserve', creditsRemaining: 0 });
    const third = await failure(source.items(items({ items: [{ itemId: '123456789012' }] })));
    expect(third.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(calls).toHaveLength(2);
    expect(source.creditsRemaining).toBe(0);
  });

  it('keeps the newest balance when parallel responses land out of order', async () => {
    const { source } = build(async ({ query }) => {
      if (query.get('listing_type') === 'buy_it_now') {
        // The older figure (fewer credits used, more remaining) answers last.
        await sleep(25);
        return json(searchBody([searchRow('111111111111', 20)], { used: 10, remaining: 501 }));
      }
      return json(searchBody([searchRow('333333333333', 1)], { used: 11, remaining: 499 }));
    });
    const result = await source.search(search({ searchTerm: 'lego' }));
    expect(result.credits).toEqual({ used: 11, remaining: 499, usedThisRequest: 2 });
    expect(source.creditsRemaining).toBe(499);
  });

  it('accepts a balance only from a response at least as far along as the last accepted one', async () => {
    const reports: Credits[] = [
      { used: 20, remaining: 480 },
      { used: 15, remaining: 485 },
      { used: null, remaining: 470 },
    ];
    let served = 0;
    const { source } = build(() => json(searchBody([searchRow('111111111111', 20)], reports[served++] ?? {})));
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(source.creditsRemaining).toBe(480);
    // A stale response (used 15 < 20) cannot move the memory.
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(source.creditsRemaining).toBe(480);
    // One that does not say how far along it is is taken at its word.
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(source.creditsRemaining).toBe(470);
  });

  it('re-reads the account before refusing, at most once a minute, and reopens the gate after a top-up', async () => {
    let clock = Date.parse('2026-09-02T18:00:00Z');
    const account: AccountStub = { used: 960, remaining: 60 };
    let vendorRemaining = 40;
    const { source, store, calls } = build(
      () => json(searchBody([searchRow('111111111111', 20)], { used: 960, remaining: vendorRemaining })),
      {},
      { now: () => new Date(clock), account },
    );

    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths(calls)).toEqual(['/account', '/request']);
    expect(source.creditsRemaining).toBe(40);

    // Below the reserve a second later: the probe is fresh, so the refusal
    // costs nothing — not even the free read.
    clock += 1_000;
    const refused = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(refused.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(paths(calls)).toEqual(['/account', '/request']);
    expect(calls[0]!.query.get('api_key')).toBe(API_KEY);

    clock += 30_000;
    const stillRefused = await failure(source.items(items({ items: [{ itemId: '123456789012' }] })));
    expect(stillRefused.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(paths(calls)).toEqual(['/account', '/request']);

    // A top-up lands; a minute on, the gate asks again and reopens.
    account.remaining = 900;
    vendorRemaining = 900;
    clock += 30_000;
    const served = await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths(calls)).toEqual(['/account', '/request', '/account', '/request']);
    expect(served.credits.remaining).toBe(900);
    expect(source.creditsRemaining).toBe(900);

    // The probe is an upstream call like any other: an audit row each, key-free.
    const probes = store.audit.events.filter((event) => (event.metadata as { requestType?: unknown } | null | undefined)?.requestType === 'account');
    expect(probes).toHaveLength(2);
    expect(probes.every((event) => event.outcome === 'ok' && event.actionClass === 'source' && event.toolName === 'ebay_api_search')).toBe(true);
    expect(probes[0]!.metadata).toMatchObject({ probe: true, trigger: 'gate', creditsLimit: 10_000, plan: 'starter' });
    expect(JSON.stringify(probes)).not.toContain(API_KEY);
    expect(JSON.stringify(store.audit.events)).not.toContain('unit@example.com');
  });

  it('a percent reserve resolves against the plan limit the account reports, probing before the first charged request', async () => {
    const admitted = build(routed({ remaining: 81 }), { creditReserve: PERCENT_5 }, { account: TRIAL });
    expect(admitted.source.effectiveCreditReserve).toBeNull();
    const result = await admitted.source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    // 5% of the trial's 100 is 5; 82 remain: admitted, and the probe came first.
    expect(paths(admitted.calls)).toEqual(['/account', '/request']);
    expect(admitted.source.effectiveCreditReserve).toBe(5);
    expect(admitted.source.creditsLimit).toBe(100);
    expect(admitted.source.planName).toBe('free');
    expect(result.warnings.some((warning) => warning.startsWith('CREDIT_RESERVE_UNRESOLVED:'))).toBe(false);

    const refused = build(routed(), { creditReserve: PERCENT_5 }, { account: { ...TRIAL, remaining: 4 } });
    const err = await failure(refused.source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(err.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(err.details).toEqual({
      gate: true,
      reason: 'below_reserve',
      kind: 'search',
      creditsRemaining: 4,
      creditsLimit: 100,
      plan: 'free',
      creditReserve: 5,
      reserveConfigured: '5%',
    });
    expect(err.message).toContain("4 credit(s) remain, below the reserve of 5 (5% of the plan's 100-credit limit)");
    expect(paths(refused.calls)).toEqual(['/account']);
  });

  it('an absolute reserve at or above the plan limit is refused as unsatisfiable, naming the fix, until the plan grows', async () => {
    let clock = Date.parse('2026-09-03T07:13:00Z');
    const account: AccountStub = { ...TRIAL };
    const { logger, lines } = fakeLogger();
    const { source, calls } = build(routed(), { creditReserve: ABSOLUTE_500 }, { account, now: () => new Date(clock), logger });

    const err = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(err.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain(
      'COUNTDOWN_CREDIT_RESERVE=500 is not below the plan\'s 100-credit limit (plan "free"); set it below the limit or to a percentage such as 5%',
    );
    expect(err.details).toEqual({
      gate: true,
      reason: 'reserve_not_below_plan_limit',
      kind: 'search',
      creditReserve: 500,
      creditsLimit: 100,
      creditsRemaining: 82,
      plan: 'free',
      reserveConfigured: '500',
    });
    expect(paths(calls)).toEqual(['/account']);
    // Items too, from memory; sellers still run; the operator was warned once.
    const items1 = await failure(source.items(items({ items: [{ itemId: '236674561036' }] })));
    expect(items1.details).toMatchObject({ reason: 'reserve_not_below_plan_limit', kind: 'items' });
    expect(paths(calls)).toEqual(['/account']);
    expect((await source.seller(seller({ loginId: 'tweedsidesales' }))).resolved).toBe(true);
    expect(lines.warn.filter((line) => line.message.includes('is not below the plan'))).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(API_KEY);

    // A plan upgrade raises the limit; a minute on, the gate re-reads and opens.
    account.plan = 'starter';
    account.limit = 10_000;
    account.remaining = 9_900;
    clock += 61_000;
    const served = await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(served.candidateCount).toBe(1);
    expect(paths(calls)).toEqual(['/account', '/request', '/account', '/request']);
  });

  it('a failed probe admits by fallback with a warning, logs it once, and is not repeated inside its cooldown', async () => {
    let clock = Date.parse('2026-09-03T11:27:00Z');
    let accountCalls = 0;
    const { logger, lines } = fakeLogger();
    const { source, calls } = build(
      (call) => {
        if (call.url.pathname === '/account') {
          accountCalls += 1;
          return accountCalls < 3 ? json({ request_info: { success: false, message: 'Parsing incident' } }, 503) : json(accountBody(TRIAL));
        }
        return routed({ remaining: 81 })(call, 0);
      },
      { creditReserve: PERCENT_5 },
      { account: 'responder', logger, now: () => new Date(clock) },
    );

    const first = await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths(calls)).toEqual(['/account', '/request']);
    expect(first.warnings).toContain(
      "CREDIT_RESERVE_UNRESOLVED: the credit balance is unknown (account probe failed: SOURCE_UNAVAILABLE: Countdown API account returned HTTP 503: Parsing incident); the 5% reserve cannot be applied to this call and the vendor's own 402 is the backstop",
    );
    // The charged response said 81 remain, but the limit is still unknown.
    // Inside the cooldown the gate does not ask again: the call is admitted
    // on the last-known figures with the limit-flavoured warning.
    clock += 1_000;
    const second = await source.items(items({ items: [{ itemId: '123456789012' }] }));
    expect(paths(calls)).toEqual(['/account', '/request', '/request']);
    expect(second.warnings.filter((warning) => warning.startsWith('CREDIT_RESERVE_UNRESOLVED:'))).toEqual([
      "CREDIT_RESERVE_UNRESOLVED: the plan's credit limit is unknown (account probe failed: SOURCE_UNAVAILABLE: Countdown API account returned HTTP 503: Parsing incident), so the 5% reserve resolves to 0 for this call and the vendor's own 402 is the backstop",
    ]);
    expect(source.effectiveCreditReserve).toBeNull();
    // The cooldown passes: the probe is repeated, fails again, and is not repeated for another minute.
    clock += CREDIT_PROBE_MIN_INTERVAL_MS;
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths(calls)).toEqual(['/account', '/request', '/request', '/account', '/request']);
    // The next cooldown passes and the probe answers: the reserve resolves and the warning goes away.
    clock += CREDIT_PROBE_MIN_INTERVAL_MS;
    const resolved = await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths(calls)).toEqual(['/account', '/request', '/request', '/account', '/request', '/account', '/request']);
    expect(resolved.warnings.some((warning) => warning.startsWith('CREDIT_RESERVE_UNRESOLVED:'))).toBe(false);
    expect(source.effectiveCreditReserve).toBe(5);
    expect(lines.warn.filter((line) => line.message.startsWith('CREDIT_RESERVE_UNRESOLVED:'))).toHaveLength(1);
  });

  it('seller lookups are exempt in every gate state', async () => {
    const unknown = build(routed(), {}, { account: 'responder' });
    expect((await unknown.source.seller(seller({ loginId: 'tweedsidesales' }))).resolved).toBe(true);
    expect(paths(unknown.calls)).toEqual(['/request']);

    const below = build(routed(), { creditReserve: PERCENT_5 }, { account: { ...TRIAL, remaining: 4 } });
    await failure(below.source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect((await below.source.seller(seller({ loginId: 'tweedsidesales' }))).resolved).toBe(true);

    const unsatisfiable = build(routed(), { creditReserve: ABSOLUTE_500 }, { account: TRIAL });
    await failure(unsatisfiable.source.items(items({ items: [{ itemId: '123456789012' }] })));
    expect((await unsatisfiable.source.seller(seller({ url: 'https://www.ebay.ca/str/jeremydoherty' }))).resolved).toBe(true);
    expect(paths(unsatisfiable.calls)).toEqual(['/account', '/request']);
  });
});

describe('ebay_api_status (§3.4)', () => {
  const NOW = new Date('2026-09-03T12:00:00.000Z');

  it('probes the account and reports plan, credits, reserve, gate and build, without the key the vendor echoes', async () => {
    const { source, store, calls } = build(routed(), { creditReserve: PERCENT_5 }, { account: TRIAL, buildSha: 'abc1234', now: () => NOW });
    const result = await source.status();
    expect(EbayApiStatusOutput.parse(result)).toBeTruthy();
    expect(result).toEqual({
      source: 'countdown',
      siteProfile: 'ebay.api.v1',
      probedAt: '2026-09-03T12:00:00.000Z',
      probe: { ok: true, httpStatus: 200, error: null },
      plan: { name: 'free', creditsLimit: 100, creditsResetAt: null },
      account: { suspended: false, vendorMessage: null },
      credits: { used: 18, remaining: 82 },
      reserve: { configured: '5%', effective: 5, basis: 'plan_limit' },
      gate: { open: true, reason: null, spendable: 77 },
      role: {
        name: 'primary',
        chargedCallsRequireFallbackReason: false,
        acceptedFallbackReasons: ['device_offline', 'bridge_unreachable', 'challenge_blocked', 'extractor_gap', 'operator_request'],
      },
      build: { gateway: 'abc1234' },
      warnings: [],
    });
    // The probe, and no credit spent.
    expect(paths(calls)).toEqual(['/account']);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain('unit@example.com');
    // One audit row, shaped like the other source tools' rows, key-free.
    const rows = store.audit.events.filter((event) => event.toolName === 'ebay_api_status');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionClass: 'source', outcome: 'ok', deviceId: null, requestId: expect.stringMatching(/^acct_\d+$/) });
    expect(rows[0]!.metadata).toMatchObject({ source: 'countdown', requestType: 'account', probe: true, trigger: 'status', creditsRemaining: 82, creditsLimit: 100, plan: 'free' });
    expect(JSON.stringify(rows)).not.toContain(API_KEY);
  });

  it('reports a shut gate with its reason, and a reset date on a paid plan', async () => {
    const unsatisfiable = build(routed(), { creditReserve: ABSOLUTE_500 }, { account: TRIAL });
    const shut = await unsatisfiable.source.status();
    expect(shut.reserve).toEqual({ configured: '500', effective: 500, basis: 'absolute' });
    expect(shut.gate).toEqual({ open: false, reason: 'reserve_not_below_plan_limit', spendable: 0 });
    expect(shut.warnings).toEqual([
      'RESERVE_NOT_BELOW_PLAN_LIMIT: COUNTDOWN_CREDIT_RESERVE=500 is not below the plan\'s 100-credit limit (plan "free"); search and item calls are refused until it is set below the limit or to a percentage such as 5%',
    ]);

    const below = build(routed(), { creditReserve: PERCENT_5 }, { account: { plan: 'hobbyist', limit: 500, used: 490, remaining: 10, resetAt: '2026-10-01T00:00:00Z' } });
    const low = await below.source.status();
    expect(low.plan).toEqual({ name: 'hobbyist', creditsLimit: 500, creditsResetAt: '2026-10-01T00:00:00Z' });
    expect(low.reserve).toEqual({ configured: '5%', effective: 25, basis: 'plan_limit' });
    expect(low.gate).toEqual({ open: false, reason: 'below_reserve', spendable: 0 });
    expect(low.warnings).toEqual([]);
  });

  it('always probes fresh: a second call inside the minute reads the account again', async () => {
    const account: AccountStub = { plan: 'starter', limit: 10_000, used: 640, remaining: 9_360 };
    const { source, calls } = build(routed(), { creditReserve: PERCENT_5 }, { account });
    expect((await source.status()).gate.spendable).toBe(8_860);
    account.used = 700;
    account.remaining = 9_300;
    expect((await source.status()).credits).toEqual({ used: 700, remaining: 9_300 });
    expect(paths(calls)).toEqual(['/account', '/account']);
  });

  it('answers from memory when the probe fails, and SOURCE_UNAVAILABLE when nothing is remembered', async () => {
    let accountCalls = 0;
    const { source } = build(
      (call) => {
        if (call.url.pathname === '/account') {
          accountCalls += 1;
          return accountCalls === 1 ? json(accountBody(TRIAL)) : json({ request_info: { success: false, message: 'Parsing incident' } }, 503);
        }
        return routed()(call, 0);
      },
      { creditReserve: PERCENT_5 },
      { account: 'responder', now: () => NOW },
    );
    expect((await source.status()).probe.ok).toBe(true);
    const remembered = await source.status();
    expect(EbayApiStatusOutput.parse(remembered)).toBeTruthy();
    expect(remembered.probe).toEqual({
      ok: false,
      httpStatus: 503,
      error: { code: 'SOURCE_UNAVAILABLE', message: 'Countdown API account returned HTTP 503: Parsing incident' },
    });
    expect(remembered.plan.creditsLimit).toBe(100);
    expect(remembered.credits).toEqual({ used: 18, remaining: 82 });
    expect(remembered.gate).toEqual({ open: true, reason: null, spendable: 77 });
    expect(remembered.warnings).toEqual([
      'ACCOUNT_PROBE_FAILED: SOURCE_UNAVAILABLE: Countdown API account returned HTTP 503: Parsing incident; the plan and credit figures are the last remembered ones (read from the account at 2026-09-03T12:00:00.000Z)',
    ]);

    const nothing = build(() => json({ request_info: { success: false, message: 'Parsing incident' } }, 503), {}, { account: 'responder' });
    const err = await failure(nothing.source.status());
    expect(err.code).toBe('SOURCE_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('no earlier figures are remembered');
    expect(err.details).toMatchObject({ reason: 'probe_failed', probe: { httpStatus: 503 } });
  });

  it('with a percent reserve whose limit is unknown, spendable is what the gate will really admit and the warnings say why', async () => {
    let accountCalls = 0;
    const { source } = build(
      (call) => {
        if (call.url.pathname === '/account') {
          accountCalls += 1;
          return json({ request_info: { success: false, message: 'Parsing incident' } }, 503);
        }
        return routed({ used: 18, remaining: 81 })(call, 0);
      },
      { creditReserve: PERCENT_5 },
      { account: 'responder' },
    );
    // Admitted by fallback; the charged response leaves a balance behind.
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    const result = await source.status();
    expect(accountCalls).toBe(2);
    expect(result.probe.ok).toBe(false);
    expect(result.credits).toEqual({ used: 18, remaining: 81 });
    expect(result.reserve).toEqual({ configured: '5%', effective: null, basis: 'unknown_limit' });
    expect(result.gate).toEqual({ open: true, reason: 'reserve_unresolved', spendable: 81 });
    expect(result.warnings.map((warning) => warning.split(':')[0])).toEqual(['ACCOUNT_PROBE_FAILED', 'CREDIT_RESERVE_UNRESOLVED']);
    expect(result.warnings[0]).toContain('from charged responses; no account read has succeeded yet');
  });

  it('through the MCP handler: takes no arguments, is the one idempotent source tool, and answers in its output shape', async () => {
    const { source } = build(routed(), { creditReserve: PERCENT_5 }, { account: TRIAL, buildSha: 'abc1234' });
    const { server, tools, configs } = fakeServer();
    registerSourceTools(server, source, { scopes: ['browser:read'], clientId: 'unit' });
    expect([...tools.keys()]).toEqual(['ebay_api_search', 'ebay_api_items', 'ebay_api_seller', 'ebay_api_status']);
    expect(configs.get('ebay_api_status')?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    for (const name of ['ebay_api_search', 'ebay_api_items', 'ebay_api_seller']) {
      expect(configs.get(name)?.annotations, name).toMatchObject({ idempotentHint: false });
    }
    const result = await tools.get('ebay_api_status')!({});
    expect(result.isError).not.toBe(true);
    const structured = EbayApiStatusOutput.parse(result.structuredContent);
    expect(structured.build.gateway).toBe('abc1234');
    expect(structured.gate.spendable).toBe(77);

    const strict = await tools.get('ebay_api_status')!({ refresh: true });
    expect(strict.isError).toBe(true);
    expect(errorPayload(strict).code).toBe('ACTION_BLOCKED');

    const denied = fakeServer();
    registerSourceTools(denied.server, source, { scopes: ['dashboards:read'], clientId: 'unit' });
    expect(errorPayload(await denied.tools.get('ebay_api_status')!({})).code).toBe('ACTION_BLOCKED');
  });

  it('startupProbe never throws, fills the memory, and logs the account without the key', async () => {
    const failing = build(() => json({ request_info: { success: false, message: 'Parsing incident' } }, 503), {}, { account: 'responder', logger: fakeLogger().logger });
    await expect(failing.source.startupProbe()).resolves.toBeUndefined();
    expect(failing.source.creditsLimit).toBeNull();

    const { logger, lines } = fakeLogger();
    const { source, store } = build(routed(), { creditReserve: PERCENT_5 }, { account: TRIAL, buildSha: 'abc1234', logger });
    await source.startupProbe();
    expect(source.creditsLimit).toBe(100);
    expect(source.planName).toBe('free');
    expect(source.effectiveCreditReserve).toBe(5);
    const line = lines.info.find((entry) => entry.message === 'Countdown API account');
    expect(line?.fields).toMatchObject({
      build: 'abc1234',
      plan: 'free',
      creditsLimit: 100,
      creditsUsed: 18,
      creditsRemaining: 82,
      reserveConfigured: '5%',
      reserveEffective: 5,
      reserveBasis: 'plan_limit',
      gateOpen: true,
      spendable: 77,
    });
    expect(JSON.stringify(lines)).not.toContain(API_KEY);
    expect(JSON.stringify(lines)).not.toContain('unit@example.com');
    // A startup probe is nobody's tool call: its row carries no tool name.
    const row = store.audit.events.find((event) => (event.metadata as { trigger?: unknown }).trigger === 'startup');
    expect(row).toMatchObject({ toolName: null, actionClass: 'source', outcome: 'ok' });

    const unsatisfiable = fakeLogger();
    const trial = build(routed(), { creditReserve: ABSOLUTE_500 }, { account: TRIAL, logger: unsatisfiable.logger });
    await trial.source.startupProbe();
    expect(unsatisfiable.lines.warn.some((entry) => entry.message.includes('COUNTDOWN_CREDIT_RESERVE=500 is not below the plan\'s 100-credit limit'))).toBe(true);
  });
});

describe('account suspension (the 2026-09-03 manual fire: a 402 that no top-up can lift)', () => {
  it('a 402 that says suspended is SOURCE_REJECTED, never a charge, and is remembered for five minutes for every kind', async () => {
    let clock = Date.parse('2026-09-03T11:27:51Z');
    const { logger, lines } = fakeLogger();
    const { source, store, calls } = build(() => suspended402(), {}, { account: { plan: 'free', limit: 100, used: 20, remaining: 80, resetAt: null }, now: () => new Date(clock), logger });

    // As in the fire: the seller lookup is the call that meets the suspension.
    const first = await failure(source.seller(seller({ loginId: 'tweedsidesales' })));
    expect(first.code).toBe('SOURCE_REJECTED');
    expect(first.retryable).toBe(false);
    expect(first.message).toContain('Countdown API account suspended (HTTP 402)');
    expect(first.message).toContain('subscribe to a Plan');
    expect(first.details).toMatchObject({ reason: 'account_suspended', httpStatus: 402, status: 402, vendorMessage: SUSPENSION_NOTICE, requestType: 'seller_profile' });
    expect(first.details.remembered).toBeUndefined();
    expect(paths(calls)).toEqual(['/request']);
    // Not a charge and not "out of credits": the balance memory is untouched.
    expect(source.creditsRemaining).toBeNull();
    expect(JSON.stringify(store.audit.events.at(-1))).toContain('SOURCE_REJECTED');

    // Every later call, seller lookups included, is refused from memory.
    const until = new Date(clock + SUSPENSION_COOLDOWN_MS).toISOString();
    for (const [kind, call] of [
      ['search', () => source.search(search({ searchTerm: 'lego', listingType: 'auction' }))],
      ['items', () => source.items(items({ items: [{ itemId: '236674561036' }] }))],
      ['seller', () => source.seller(seller({ loginId: 'tweedsidesales' }))],
    ] as const) {
      const refused = await failure(call());
      expect(refused.code, kind).toBe('SOURCE_REJECTED');
      expect(refused.retryable, kind).toBe(false);
      expect(refused.details, kind).toEqual({ reason: 'account_suspended', remembered: true, httpStatus: 402, vendorMessage: SUSPENSION_NOTICE, suspendedUntil: until, kind });
      expect(refused.message, kind).toContain(`${kind} calls are refused without contacting the vendor until ${until}`);
      expect(refused.message, kind).toContain('No top-up lifts a suspension');
    }
    expect(paths(calls)).toEqual(['/request']);
    expect(lines.warn.some((line) => line.message.includes('suspended by the vendor'))).toBe(true);

    // The status tool says so, probing the free endpoint (which answers) all the same.
    const status = await source.status();
    expect(EbayApiStatusOutput.parse(status)).toBeTruthy();
    expect(status.probe.ok).toBe(true);
    expect(status.account).toEqual({ suspended: true, vendorMessage: SUSPENSION_NOTICE });
    expect(status.gate).toEqual({ open: false, reason: 'account_suspended', spendable: 0 });
    expect(status.credits).toEqual({ used: 20, remaining: 80 });
    expect(status.warnings[0]).toBe(
      `ACCOUNT_SUSPENDED: ${SUSPENSION_NOTICE}; every ebay_api_* call is refused without contacting the vendor until ${until}. No top-up lifts a suspension: the vendor removes it when a plan is subscribed`,
    );
    expect(paths(calls)).toEqual(['/request', '/account']);

    // Inside the cooldown nothing reaches the vendor; once it passes, the vendor is asked again.
    clock += SUSPENSION_COOLDOWN_MS - 1_000;
    expect((await failure(source.seller(seller({ loginId: 'tweedsidesales' })))).details).toMatchObject({ remembered: true });
    expect(paths(calls)).toEqual(['/request', '/account']);
    clock += 2_000;
    const again = await failure(source.seller(seller({ loginId: 'tweedsidesales' })));
    expect(again.details).toMatchObject({ reason: 'account_suspended', requestType: 'seller_profile' });
    expect(again.details.remembered).toBeUndefined();
    expect(paths(calls)).toEqual(['/request', '/account', '/request']);
    // ...and remembered afresh from that answer.
    const renewed = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(renewed.details).toMatchObject({ remembered: true, suspendedUntil: new Date(clock + SUSPENSION_COOLDOWN_MS).toISOString() });
    expect(paths(calls)).toEqual(['/request', '/account', '/request']);
  });

  it('a plain 402 stays out-of-credits: the balance reads 0 and the reserve gate takes over', async () => {
    const { source, calls } = build(() => json({ request_info: { success: false, message: 'Out of credits' } }, 402), {}, { account: { remaining: 0 } });
    const err = await failure(source.seller(seller({ loginId: 'tweedsidesales' })));
    expect(err.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(err.details.reason).toBeUndefined();
    expect(source.creditsRemaining).toBe(0);
    // Below the reserve with no probe on record: the account is read once (it agrees), then the gate refuses.
    const next = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(next.details).toMatchObject({ reason: 'below_reserve', creditsRemaining: 0 });
    expect(paths(calls)).toEqual(['/request', '/account']);
    expect((await source.status()).account).toEqual({ suspended: false, vendorMessage: null });
  });

  it('the status probe answering 402-suspended records the suspension and still returns the status', async () => {
    const { source, calls } = build(routed(), {}, { account: 'responder' });
    // Nothing is known and the free endpoint itself is refused: still an answer, not a throw.
    const { source: fresh, calls: freshCalls } = build((call) => (call.url.pathname === '/account' ? suspended402() : routed()(call, 0)), {}, { account: 'responder' });
    const status = await fresh.status();
    expect(EbayApiStatusOutput.parse(status)).toBeTruthy();
    expect(status.probe).toMatchObject({ ok: false, httpStatus: 402, error: { code: 'SOURCE_REJECTED' } });
    expect(status.account).toEqual({ suspended: true, vendorMessage: SUSPENSION_NOTICE });
    expect(status.gate).toEqual({ open: false, reason: 'account_suspended', spendable: 0 });
    expect(status.plan).toEqual({ name: null, creditsLimit: null, creditsResetAt: null });
    expect(paths(freshCalls)).toEqual(['/account']);
    const refused = await failure(fresh.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(refused.details).toMatchObject({ reason: 'account_suspended', remembered: true });
    expect(paths(freshCalls)).toEqual(['/account']);
    // A source whose probe fails for any other reason with nothing known still throws.
    void source;
    void calls;
  });

  it('a suspension met mid-batch lands in its slot and the remaining slots are refused from memory', async () => {
    const { source, calls } = build(() => suspended402(), { maxConcurrency: 1 }, { account: { remaining: 80 } });
    const result = await source.items(items({ items: [{ itemId: '100000000001' }, { itemId: '100000000002' }, { itemId: '100000000003' }] }));
    expect(paths(calls)).toEqual(['/account', '/request']);
    expect(result).toMatchObject({ status: 'completed', requested: 3, completed: 3, succeeded: 0, failed: 3 });
    expect(result.results[0]!.error).toMatchObject({ code: 'SOURCE_REJECTED', retryable: false });
    expect(result.results[1]!.error?.message).toContain('refused without contacting the vendor');
    expect(result.results[2]!.error?.message).toContain('refused without contacting the vendor');
    expect(result.warnings.some((warning) => warning.startsWith('SOURCE_CREDITS_EXHAUSTED:'))).toBe(false);
    expect(result.credits.usedThisRequest).toBe(0);
  });
});

describe('the account probe never holds the gate (the 2026-09-03 hang: three searches timed out at the client)', () => {
  const NOTHING: Credits = { used: null, remaining: null };

  it('with an account endpoint that never answers, a searchTerm search and a url search both answer within the probe timeout with the same decision', async () => {
    let clock = Date.parse('2026-09-03T11:30:00Z');
    let hangs = 0;
    const { source, calls } = build(
      (call, ordinal) => (call.url.pathname === '/account' ? hanging(() => { hangs += 1; })(call, ordinal) : routed(NOTHING)(call, ordinal)),
      {},
      { account: 'responder', probeTimeoutMs: 100, now: () => new Date(clock) },
    );
    const startedAt = Date.now();
    const byTerm = await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    const termElapsed = Date.now() - startedAt;
    expect(termElapsed).toBeLessThan(2_000);
    expect(byTerm.warnings.some((warning) => warning.startsWith('CREDIT_RESERVE_UNRESOLVED:') && warning.includes('timed out after 100 ms'))).toBe(true);
    expect(paths(calls)).toEqual(['/account', '/request']);
    expect(hangs).toBe(1);

    // The url form shares the gate; inside the cooldown it does not wait on a second probe.
    const urlStarted = Date.now();
    const byUrl = await source.search(search({ url: 'https://www.ebay.ca/sch/i.html?_ssn=tweedsidesales&_nkw=lego&LH_Auction=1' }));
    expect(Date.now() - urlStarted).toBeLessThan(500);
    expect(byUrl.warnings.some((warning) => warning.startsWith('CREDIT_RESERVE_UNRESOLVED:'))).toBe(true);
    expect(paths(calls)).toEqual(['/account', '/request', '/request']);

    // After the cooldown the probe is tried again, on the same short terms.
    clock += CREDIT_PROBE_MIN_INTERVAL_MS;
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(paths(calls)).toEqual(['/account', '/request', '/request', '/account', '/request']);
    expect(hangs).toBe(2);
  });

  it('with a balance below the reserve and a stale probe, both forms are refused on the last-known figures without waiting past the probe timeout', async () => {
    let clock = Date.parse('2026-09-03T11:30:00Z');
    let accountHangs = false;
    const { source, calls } = build(
      (call, ordinal) => {
        if (call.url.pathname === '/account') return accountHangs ? hanging()(call, ordinal) : json(accountBody({ remaining: 40 }));
        return routed({ remaining: 40 })(call, ordinal);
      },
      {},
      { account: 'responder', probeTimeoutMs: 100, now: () => new Date(clock) },
    );
    // The memory is filled and the gate shut by an answering probe.
    expect((await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })))).details).toMatchObject({ reason: 'below_reserve', creditsRemaining: 40 });
    expect(paths(calls)).toEqual(['/account']);

    // A minute on the probe is stale; now the endpoint hangs.
    accountHangs = true;
    clock += CREDIT_PROBE_MIN_INTERVAL_MS;
    const startedAt = Date.now();
    const byTerm = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(byTerm.details).toMatchObject({ reason: 'below_reserve', creditsRemaining: 40 });
    expect(paths(calls)).toEqual(['/account', '/account']);

    const urlStarted = Date.now();
    const byUrl = await failure(source.search(search({ url: 'https://www.ebay.ca/sch/i.html?_nkw=lego&LH_Auction=1' })));
    expect(Date.now() - urlStarted).toBeLessThan(500);
    expect(byUrl.details).toMatchObject({ reason: 'below_reserve', creditsRemaining: 40 });
    expect(paths(calls)).toEqual(['/account', '/account']);
  });

  it('two concurrent searches share one probe', async () => {
    const { source, calls } = build(
      (call, ordinal) => (call.url.pathname === '/account' ? sleep(50).then(() => json(accountBody({ remaining: 900 }))) : routed({ remaining: 900 })(call, ordinal)),
      {},
      { account: 'responder' },
    );
    await Promise.all([
      source.search(search({ searchTerm: 'lego', listingType: 'auction' })),
      source.search(search({ url: 'https://www.ebay.ca/sch/i.html?_nkw=lego&LH_Auction=1' })),
    ]);
    expect(paths(calls)).toEqual(['/account', '/request', '/request']);
  });

  it('the probe runs on its own terms: 8 s and no retry, while a charged request keeps the retry ladder', async () => {
    expect(CREDIT_PROBE_TIMEOUT_MS).toBe(8_000);
    const { source, calls } = build(() => json({ request_info: { success: false, message: 'transient (G)' } }, 500), {}, {
      account: 'responder',
      retryDelaysMs: [0, 0],
      sleep: async () => {},
    });
    const err = await failure(source.search(search({ searchTerm: 'lego', listingType: 'auction' })));
    expect(err.code).toBe('SOURCE_UNAVAILABLE');
    // One probe attempt, then the charged request's three.
    expect(paths(calls)).toEqual(['/account', '/request', '/request', '/request']);
  });

  it('the probe cap applies to the status tool too, so an operator is answered promptly', async () => {
    const { source, calls } = build((call, ordinal) => (call.url.pathname === '/account' ? hanging()(call, ordinal) : routed()(call, ordinal)), {}, { account: 'responder', probeTimeoutMs: 100 });
    const startedAt = Date.now();
    const err = await failure(source.status());
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(err.code).toBe('SOURCE_UNAVAILABLE');
    expect(err.details).toMatchObject({ reason: 'probe_failed' });
    expect(paths(calls)).toEqual(['/account']);
  });
});

describe('credits.usedThisRequest (what this call spent)', () => {
  const splitSets =
    (bin: Credits, auction: Credits): Responder =>
    ({ query }) => {
      const listingType = query.get('listing_type');
      if (listingType === 'buy_it_now') return json(searchBody([searchRow('111111111111', 20)], bin));
      if (listingType === 'auction') return json(searchBody([searchRow('333333333333', 1)], auction));
      return json({ request_info: { success: false, message: 'unfiltered search issued' } }, 400);
    };

  it('sums credits_used_this_request over both halves of a split search, while used stays the account total', async () => {
    const { source } = build(splitSets({ used: 15, remaining: 85, usedThisRequest: 1 }, { used: 16, remaining: 84, usedThisRequest: 1 }));
    const result = await source.search(search({ searchTerm: 'lego' }));
    expect(result.credits).toEqual({ used: 16, remaining: 84, usedThisRequest: 2 });
  });

  it('counts a response that omits the figure at its contract cost: one credit per page fetched', async () => {
    const { source } = build(splitSets({ usedThisRequest: 1 }, { usedThisRequest: null }));
    const oneOmitted = await source.search(search({ searchTerm: 'lego' }));
    expect(oneOmitted.credits.usedThisRequest).toBe(2);

    // A three-page request is one response costing three credits. The
    // buy_it_now half says so; the auction half omits the figure and is
    // counted at the same contract cost, one per page fetched.
    const threePages = build(({ query }) => {
      const reports = query.get('listing_type') === 'buy_it_now';
      return json({
        request_info: requestInfo({ usedThisRequest: reports ? 3 : null }),
        request_metadata: { pages: [{ ebay_url: 'https://www.ebay.ca/sch/i.html?_nkw=lego' }] },
        search_results: [searchRow(reports ? '111111111111' : '333333333333', 20)],
        pagination: {
          pages: [
            { current_page: 1, total_results: 3, has_next_page: true },
            { current_page: 2, total_results: 3, has_next_page: true },
            { current_page: 3, total_results: 3, has_next_page: false },
          ],
        },
      });
    });
    const paged = await threePages.source.search(search({ searchTerm: 'lego', maxPage: 3 }));
    expect(paged.pagesFetched).toBe(3);
    expect(paged.credits.usedThisRequest).toBe(6);
  });

  it('is null only when no response carried the figure, and 0 when nothing was charged', async () => {
    const { source } = build(splitSets({ usedThisRequest: null }, { usedThisRequest: null }));
    const unreported = await source.search(search({ searchTerm: 'lego' }));
    expect(unreported.credits).toEqual({ used: 10, remaining: 990, usedThisRequest: null });
    // The same on a one-request call: an entirely assumed figure is never
    // reported as a measured one, so the contract cost fills gaps only.
    const single = build(routed({ usedThisRequest: null }));
    const profile = await single.source.seller(seller({ loginId: 'tweedsidesales' }));
    expect(profile.credits).toEqual({ used: 10, remaining: 990, usedThisRequest: null });

    // Every item rejected: no charged response, so the call spent nothing.
    const rejected = build(() => json({ request_info: { success: false, message: 'Invalid url' } }, 400));
    const nothing = await rejected.source.items(items({ items: [{ itemId: '100000000001' }, { itemId: '100000000002' }] }));
    expect(nothing).toMatchObject({ status: 'completed', requested: 2, completed: 2, succeeded: 0, failed: 2 });
    expect(nothing.credits).toEqual({ used: null, remaining: null, usedThisRequest: 0 });
  });
});

describe('named destinations (§2 Destinations)', () => {
  it('sends the Toronto postal code on a toronto search and the forwarder suite on a forwarder search', async () => {
    const { source, calls } = build(routed());
    await source.search(search({ searchTerm: 'lego', listingType: 'auction', destination: 'toronto' }));
    expect(requests(calls)[0]!.query.get('customer_location')).toBe('ca');
    expect(requests(calls)[0]!.query.get('customer_zipcode')).toBe('M6H2W9');

    await source.search(search({ searchTerm: 'lego', listingType: 'auction', destination: 'forwarder', domain: 'ebay.com' }));
    expect(requests(calls)[1]!.query.get('customer_location')).toBe('us');
    expect(requests(calls)[1]!.query.get('customer_zipcode')).toBe('34249');
    expect(requests(calls)[1]!.query.get('ebay_domain')).toBe('ebay.com');
  });

  it('sends no location at all under domain_default', async () => {
    const { source, calls } = build(routed());
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(requests(calls)[0]!.query.has('customer_location')).toBe(false);
    expect(requests(calls)[0]!.query.has('customer_zipcode')).toBe(false);
    await source.items(items({ items: [{ itemId: '123456789012' }] }));
    expect(requests(calls)[1]!.query.has('customer_location')).toBe(false);
    expect(requests(calls)[1]!.query.has('customer_zipcode')).toBe(false);
  });

  it('never sends a zip on a product request, whatever the destination', async () => {
    const { source, calls } = build(routed());
    await source.items(items({ items: [{ itemId: '123456789012' }], destination: 'toronto' }));
    await source.items(items({ items: [{ itemId: '123456789012' }], destination: 'forwarder' }));
    const charged = requests(calls);
    for (const call of charged) {
      expect(call.query.get('type')).toBe('product');
      expect(call.query.has('customer_zipcode')).toBe(false);
    }
    expect(charged[0]!.query.get('customer_location')).toBe('ca');
    expect(charged[1]!.query.get('customer_location')).toBe('us');
  });

  it('normalises the configured postal code to uppercase with no whitespace before sending it', async () => {
    const { source, calls } = build(routed(), {
      destinations: {
        toronto: { customerLocation: 'ca', customerZipcode: 'm6h 2w9' },
        forwarder: { customerLocation: 'us', customerZipcode: '34249' },
      },
    });
    await source.search(search({ searchTerm: 'lego', listingType: 'auction', destination: 'toronto' }));
    expect(requests(calls)[0]!.query.get('customer_zipcode')).toBe('M6H2W9');
  });

  it('the key rides only in the outbound query string', async () => {
    const { source, store, calls } = build(routed());
    const result = await source.search(search({ searchTerm: 'lego', listingType: 'auction', destination: 'toronto' }));
    for (const call of calls) {
      expect(call.query.get('api_key')).toBe(API_KEY);
      expect(call.url.origin).toBe('https://api.countdownapi.com');
    }
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
    const charged = requests(calls);
    expect(charged).toHaveLength(2);
    expect(charged.map((call) => call.query.get('listing_type')).sort()).toEqual(['auction', 'buy_it_now']);
    expect(charged.every((call) => call.query.get('search_term') === 'lego minifigure lot')).toBe(true);

    expect(EbayApiSearchOutput.parse(result)).toBeTruthy();
    expect(result.retrievedUnder).toEqual(['buy_it_now', 'auction']);
    expect(result.candidateCount).toBe(3);
    const formats = new Map(result.candidates.map((candidate) => [candidate.itemId, candidate.sellingFormat]));
    expect(formats.get('111111111111')).toBe('fixed_price');
    expect(formats.get('222222222222')).toBe('auction_with_bin');
    expect(formats.get('333333333333')).toBe('auction');
    // Both filters' totals, both request ids, the latest balance, and the
    // two credits this call spent (used is the account total, not the spend).
    expect(result.totalResults).toBe(4);
    expect(result.requestIds).toHaveLength(2);
    expect(result.credits).toEqual({ used: 12, remaining: 988, usedThisRequest: 2 });
    expect(result.pagesFetched).toBe(1);
    expect(result.hasNextPage).toBe(false);
    expect(result.warnings.some((warning) => warning.startsWith('BID_COUNT_UNAVAILABLE_FROM_SOURCE:'))).toBe(true);
    // The API default field set carries the zip-scoped shipping figure.
    expect(result.candidates[0]).toMatchObject({ shippingCost: 9.99, priceRange: false, condition: 'Pre-Owned' });
  });

  it('any other listing type is one request retrieved under that filter', async () => {
    const { source, calls } = build(twoSets);
    const result = await source.search(search({ searchTerm: 'lego', listingType: 'auction', sortBy: 'newly_listed' }));
    const charged = requests(calls);
    expect(charged).toHaveLength(1);
    expect(charged[0]!.query.get('listing_type')).toBe('auction');
    expect(charged[0]!.query.get('sort_by')).toBe('newly_listed');
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
    const charged = requests(calls);
    expect(charged).toHaveLength(2);
    expect(charged.every((call) => !call.query.has('listing_type') && !call.query.has('search_term'))).toBe(true);
    const targets = charged.map((call) => new URL(call.query.get('url')!));
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
    const charged = requests(calls);
    expect(charged).toHaveLength(1);
    expect(charged[0]!.query.get('url')).toBe(url);
    expect(charged[0]!.query.get('customer_zipcode')).toBe('34249');
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
      await sleep(index % 2 === 0 ? 30 : 5);
      inFlight -= 1;
      return json(productBody(itemId));
    }, { maxConcurrency: 2 });

    const result = await source.items(items({ items: ITEM_IDS.map((itemId) => ({ itemId })), destination: 'toronto' }));
    expect(requests(calls)).toHaveLength(5);
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
    expect(result.credits.usedThisRequest).toBe(5);
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
    expect(requests(calls)).toHaveLength(3);
    expect(result).toMatchObject({ status: 'completed', requested: 3, completed: 3, succeeded: 1, failed: 2 });

    expect(result.results[0]!.ok).toBe(true);
    // The dead listing was a charged response like the live one; the
    // rejected request was answered with nothing and cost nothing.
    expect(result.credits.usedThisRequest).toBe(2);

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

    // One audit row per upstream call, shaped like the broker's, key-free:
    // the gate's probe plus the three product requests.
    const rows = store.audit.events.filter((event) => event.toolName === 'ebay_api_items');
    expect(rows).toHaveLength(4);
    const charged = rows.filter((row) => (row.metadata as { requestType?: unknown }).requestType === 'product');
    expect(charged.map((row) => row.outcome).sort()).toEqual(['error', 'ok', 'ok']);
    expect(charged.find((row) => row.outcome === 'error')?.errorCode).toBe('SOURCE_REJECTED');
    for (const row of rows) {
      expect(row.actionClass).toBe('source');
      expect(row.deviceId).toBeNull();
      expect(row.metadata).toMatchObject({ source: 'countdown' });
      expect(JSON.stringify(row)).not.toContain(API_KEY);
      expect(JSON.stringify(row)).not.toContain('countdownapi.com/request?');
    }
    expect(charged.filter((row) => row.outcome === 'ok').every((row) => typeof row.requestId === 'string')).toBe(true);
  });

  it('a reserve crossed mid-batch refuses the remaining slots instead of the batch', async () => {
    const { source, calls } = build(
      ({ query }) => json(productBody(/\/itm\/(\d+)/.exec(query.get('url') ?? '')![1]!, { remaining: 49 })),
      { maxConcurrency: 1 },
      { account: { remaining: 60 } },
    );
    const result = await source.items(items({ items: ITEM_IDS.slice(0, 3).map((itemId) => ({ itemId })) }));
    // One charged request: the first slot's response crossed the reserve,
    // and the next two trusted the minute-old probe.
    expect(paths(calls)).toEqual(['/account', '/request']);
    expect(result).toMatchObject({ status: 'completed', requested: 3, completed: 3, succeeded: 1, failed: 2 });
    expect(result.results[0]!.ok).toBe(true);
    expect(result.results[1]!.error?.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(result.results[2]!.error?.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(result.warnings).toContain(
      'SOURCE_CREDITS_EXHAUSTED: 2 item(s) were not requested because the credit balance fell below the reserve of 50 during the batch; their slots carry the error.',
    );
    // One credit spent: the two refused slots never reached the vendor.
    expect(result.credits).toEqual({ used: 10, remaining: 49, usedThisRequest: 1 });
  });

  it('serves the full provenance record when compact is false and takes the domain from an item url', async () => {
    const { source, calls } = build(({ query }) => json(productBody(/\/itm\/(\d+)/.exec(query.get('url') ?? '')![1]!)));
    const result = await source.items(
      items({ items: [{ url: 'https://www.ebay.com/itm/167665350336', expectedFormat: 'fixed_price' }], compact: false }),
    );
    expect(requests(calls)[0]!.query.get('url')).toBe('https://www.ebay.com/itm/167665350336');
    const record = result.results[0]!.record as { siteProfile: string; itemPrice: { source: string } | null; sellingFormat: { kind: string } };
    expect(record.siteProfile).toBe('ebay.api.v1');
    expect(record.itemPrice?.source).toBe('api');
    expect(record.sellingFormat.kind).toBe('fixed_price');
    expect(result.compact).toBe(false);
  });
});

describe('items under the tool deadline (§3.2; the MCP client allows a tool 60 s)', () => {
  const ITEM_IDS = ['100000000001', '100000000002', '100000000003', '100000000004', '100000000005'];

  it('returns the answered slots before the deadline, marks in-flight and unrequested items for re-request, and aborts what is in flight', async () => {
    let aborted = 0;
    const { source, store, calls } = build(
      (call, ordinal) => {
        const itemId = /\/itm\/(\d+)/.exec(call.query.get('url') ?? '')![1]!;
        if (itemId === ITEM_IDS[0]) return sleep(200).then(() => json(productBody(itemId)));
        return hanging(() => {
          aborted += 1;
        })(call, ordinal);
      },
      // One request's worth of headroom is 2 s here (COUNTDOWN_TIMEOUT_MS),
      // and the batch answers 1.4 s before its 3 s deadline, so the second
      // item — launched at about 200 ms with 2.8 s left — is still in
      // flight when the batch answers, however slow the test host.
      { maxConcurrency: 1, timeoutMs: 2_000 },
      { batchReturnGuardMs: 1_400 },
    );
    const deadline = startDeadline(3_000);
    const startedAt = Date.now();
    try {
      const result = await source.items(items({ items: ITEM_IDS.map((itemId) => ({ itemId })) }), undefined, deadline);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(3_000);
      expect(EbayApiItemsOutput.parse(result)).toBeTruthy();
      expect(result).toMatchObject({ status: 'partial', requested: 5, completed: 1, succeeded: 1, failed: 0 });
      expect(result.results).toHaveLength(5);
      expect(result.results[0]!.ok).toBe(true);

      // Launched at 200 ms with 2.8 s left, still unanswered at the guard: possibly charged.
      const inFlight = result.results[1]!;
      expect(inFlight).toMatchObject({ ok: false, record: null, finalUrl: null });
      expect(inFlight.error).toEqual({
        code: 'SOURCE_UNAVAILABLE',
        message: 'Not answered: the request was still in flight at the 3 s tool deadline and was abandoned; the vendor may still have served and charged it. Re-request this item.',
        retryable: true,
        details: { reason: 'deadline', requested: true, possiblyCharged: true },
      });
      // Never launched: never charged.
      for (const slot of result.results.slice(2)) {
        expect(slot.error).toEqual({
          code: 'SOURCE_UNAVAILABLE',
          message: 'Not requested: the 3 s tool deadline left no room for another vendor request, so nothing was sent and nothing was charged. Re-request this item.',
          retryable: true,
          details: { reason: 'deadline', requested: false, possiblyCharged: false },
        });
      }
      expect(result.warnings).toContain(
        'BATCH_TRUNCATED_BY_DEADLINE: 4 of 5 items not answered within the 3 s tool budget; re-request the listed ids: 100000000002, 100000000003, 100000000004, 100000000005',
      );
      // Answered requests only.
      expect(result.credits.usedThisRequest).toBe(1);
      expect(result.requestIds).toHaveLength(1);
      expect(requests(calls)).toHaveLength(2);
      const { source: _source, credits: _credits, requestIds: _requestIds, ...bridgeShape } = result;
      expect(ExtractManyOutput.parse(bridgeShape)).toBeTruthy();
    } finally {
      // The MCP layer disposes of the deadline once the handler answers: the in-flight fetch is aborted then.
      deadline.dispose();
    }
    await sleep(50);
    expect(aborted).toBe(1);
    // Nothing launched after the cutoff, and the abandoned request left its own audit row.
    expect(requests(calls)).toHaveLength(2);
    const rows = store.audit.events.filter((event) => event.toolName === 'ebay_api_items' && (event.metadata as { requestType?: unknown }).requestType === 'product');
    expect(rows.map((row) => row.outcome).sort()).toEqual(['error', 'ok']);
    expect(rows.find((row) => row.outcome === 'error')).toMatchObject({ errorCode: 'SOURCE_UNAVAILABLE', metadata: expect.objectContaining({ abandoned: true, possiblyCharged: true }) });
  });

  it('launches no request the remaining budget cannot hold, and answers at once rather than waiting for the deadline', async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ itemId: String(100000000001 + index) }));
    const { source, calls } = build(
      ({ query }) => sleep(30).then(() => json(productBody(/\/itm\/(\d+)/.exec(query.get('url') ?? '')![1]!))),
      { maxConcurrency: 1, timeoutMs: 1_000 },
    );
    const deadline = startDeadline(1_500);
    const startedAt = Date.now();
    try {
      const result = await source.items(items({ items: many }), undefined, deadline);
      // The pool stopped when under 1 s remained (about 500 ms in) and the
      // call answered then, not at the deadline.
      expect(Date.now() - startedAt).toBeLessThan(1_300);
      expect(result.status).toBe('partial');
      expect(result.completed).toBeGreaterThanOrEqual(3);
      expect(result.completed).toBeLessThan(25);
      expect(requests(calls)).toHaveLength(result.completed);
      const unrequested = result.results.filter((slot) => slot.error?.details?.requested === false);
      expect(unrequested).toHaveLength(25 - result.completed);
      expect(result.results.some((slot) => slot.error?.details?.requested === true)).toBe(false);
      const warning = result.warnings.find((entry) => entry.startsWith('BATCH_TRUNCATED_BY_DEADLINE:'));
      expect(warning).toContain(`${25 - result.completed} of 25 items not answered within the 1.5 s tool budget; re-request the listed ids: ${unrequested.map((slot) => /\/itm\/(\d+)/.exec(slot.url)![1]).join(', ')}`);
      expect(result.credits.usedThisRequest).toBe(result.completed);
    } finally {
      deadline.dispose();
    }
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
    expect(result.credits).toEqual({ used: 3, remaining: 97, usedThisRequest: 1 });
    expect(result.requestIds).toHaveLength(1);
    // The stub's seller block, like the measured one, has none of the four optional fields.
    expect(result.warnings).toContain(
      'SELLER_FIELDS_ABSENT_FROM_SOURCE: the vendor returned no member-since, location, top-rated or description for this profile',
    );
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

  it('a vendor that never answers cannot hold a search open past the deadline, and the error says the credit may have been charged', async () => {
    const { source } = build(hanging());
    const { server, tools } = fakeServer();
    registerSourceTools(server, source, READ, { timeoutMs: 40 });
    expect([...tools.keys()]).toEqual(['ebay_api_search', 'ebay_api_items', 'ebay_api_seller', 'ebay_api_status']);

    const result = await tools.get('ebay_api_search')!({ searchTerm: 'lego', listingType: 'auction' });
    expect(result.isError).toBe(true);
    expect(errorPayload(result)).toEqual({
      code: 'SOURCE_UNAVAILABLE',
      retryable: true,
      message: 'tool deadline of 40 ms exceeded; the vendor may still have served and charged the abandoned request, so re-issue it after 5000 ms (a smaller num finishes sooner)',
      details: { deadlineMs: 40, reason: 'deadline', possiblyCharged: true, retryAfterMs: 5_000 },
    });
  });

  it("the status tool's deadline error says nothing was charged", async () => {
    const { source } = build(hanging(), {}, { account: 'responder' });
    const { server, tools } = fakeServer();
    registerSourceTools(server, source, READ, { timeoutMs: 40 });
    const result = await tools.get('ebay_api_status')!({});
    expect(result.isError).toBe(true);
    expect(errorPayload(result)).toEqual({
      code: 'SOURCE_UNAVAILABLE',
      retryable: true,
      message: 'tool deadline of 40 ms exceeded',
      details: { deadlineMs: 40, reason: 'deadline', possiblyCharged: false },
    });
  });

  it('an item batch answers the partial result through the handler, never the deadline error, and the pool issues nothing afterwards', async () => {
    let aborted = 0;
    const { source, calls } = build(
      (call, ordinal) => {
        const itemId = /\/itm\/(\d+)/.exec(call.query.get('url') ?? '')![1]!;
        if (itemId === '100000000001') return sleep(200).then(() => json(productBody(itemId)));
        return hanging(() => {
          aborted += 1;
        })(call, ordinal);
      },
      { maxConcurrency: 1, timeoutMs: 2_000 },
      { batchReturnGuardMs: 1_400 },
    );
    const { server, tools } = fakeServer();
    registerSourceTools(server, source, READ, { timeoutMs: 3_000 });

    const result = await tools.get('ebay_api_items')!({
      items: [{ itemId: '100000000001' }, { itemId: '100000000002' }, { itemId: '100000000003' }],
    });
    expect(result.isError).not.toBe(true);
    const structured = EbayApiItemsOutput.parse(result.structuredContent);
    expect(structured).toMatchObject({ status: 'partial', requested: 3, completed: 1, succeeded: 1 });
    expect(structured.results[1]!.error?.details).toEqual({ reason: 'deadline', requested: true, possiblyCharged: true });
    expect(structured.results[2]!.error?.details).toEqual({ reason: 'deadline', requested: false, possiblyCharged: false });

    // The handler disposed of the deadline as it answered: the in-flight
    // fetch was aborted, and nothing else was ever launched.
    await sleep(50);
    expect(aborted).toBe(1);
    expect(requests(calls)).toHaveLength(2);
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

  it('names the reason and ORIGIN_DENIED for a refused url on every tool, before the schema, the gate and any vendor call', async () => {
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

  it('the source screens a url before the gate, so a refused url costs not even the free probe', async () => {
    const { source, calls } = build(routed());
    const searchDefaults = search({ searchTerm: 'lego' });
    await expect(source.search({ ...searchDefaults, searchTerm: undefined, url: 'https://evil.example/sch/i.html?_nkw=lego' })).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    const itemDefaults = items({ items: [{ itemId: '123456789012' }] });
    await expect(source.items({ ...itemDefaults, items: [{ itemId: '123456789012' }, { url: 'https://10.0.0.5/itm/123456789012' }] })).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    expect(calls).toHaveLength(0);
  });
});

describe('role gate (§2.1): the source is a secondary pathway unless configured otherwise', () => {
  it('refuses every charged kind without a fallbackReason, before any probe or credit', async () => {
    const { source, calls } = build(routed(), { role: 'secondary' });
    for (const [kind, call] of [
      ['search', () => source.search(search({ searchTerm: 'lego', listingType: 'auction' }))],
      ['items', () => source.items(items({ items: [{ itemId: '111111111111' }] }))],
      ['seller', () => source.seller(seller({ loginId: 'tweedsidesales' }))],
    ] as const) {
      const refused = await failure(call());
      expect(refused.code, kind).toBe('SOURCE_REJECTED');
      expect(refused.retryable, kind).toBe(false);
      expect(refused.details).toMatchObject({ reason: 'secondary_role', role: 'secondary', kind, gate: true });
      expect(refused.details.acceptedFallbackReasons).toEqual([
        'device_offline',
        'bridge_unreachable',
        'challenge_blocked',
        'extractor_gap',
        'operator_request',
      ]);
      expect(refused.message).toMatch(/Browser Bridge first/);
    }
    // Nothing reached the vendor: not the account probe, not a request.
    expect(calls).toHaveLength(0);
  });

  it('admits a charged call that declares its fallback and records the declaration on the audit row', async () => {
    const { source, store, calls } = build(routed({ remaining: 900 }), { role: 'secondary' });
    const result = await source.search(search({ searchTerm: 'lego', listingType: 'auction', fallbackReason: 'device_offline', fallbackNote: 'DEVICE_OFFLINE desktop last seen 15:08Z' }));
    expect(result.candidateCount).toBe(1);
    expect(requests(calls)).toHaveLength(1);
    const row = JSON.stringify(store.audit.events.at(-1));
    expect(row).toContain('"fallbackReason":"device_offline"');
    expect(row).toContain('DEVICE_OFFLINE desktop last seen 15:08Z');

    const profile = await source.seller(seller({ loginId: 'tweedsidesales', fallbackReason: 'challenge_blocked' }));
    expect(profile.resolved).toBe(true);
    expect(JSON.stringify(store.audit.events.at(-1))).toContain('"fallbackReason":"challenge_blocked"');
  });

  it('under the primary role a declaration is optional and still audited when given', async () => {
    const { source, store } = build(routed({ remaining: 900 }), { role: 'primary' });
    await source.search(search({ searchTerm: 'lego', listingType: 'auction' }));
    expect(JSON.stringify(store.audit.events.at(-1))).not.toContain('fallbackReason');
    await source.search(search({ searchTerm: 'lego', listingType: 'auction', fallbackReason: 'operator_request' }));
    expect(JSON.stringify(store.audit.events.at(-1))).toContain('"fallbackReason":"operator_request"');
  });

  it('the status tool reports the role and warns that spendable is a fallback budget under secondary', async () => {
    const secondary = build(routed(), { role: 'secondary' });
    const status = EbayApiStatusOutput.parse(await secondary.source.status());
    expect(status.role).toEqual({
      name: 'secondary',
      chargedCallsRequireFallbackReason: true,
      acceptedFallbackReasons: ['device_offline', 'bridge_unreachable', 'challenge_blocked', 'extractor_gap', 'operator_request'],
    });
    expect(status.warnings.some((warning) => warning.startsWith('SECONDARY_ROLE'))).toBe(true);
    // The credit arithmetic is still reported: a declared fallback plans against it.
    expect(status.gate.open).toBe(true);

    const primary = build(routed(), { role: 'primary' });
    const primaryStatus = EbayApiStatusOutput.parse(await primary.source.status());
    expect(primaryStatus.role.name).toBe('primary');
    expect(primaryStatus.role.chargedCallsRequireFallbackReason).toBe(false);
    expect(primaryStatus.warnings.some((warning) => warning.startsWith('SECONDARY_ROLE'))).toBe(false);
  });

  it('the MCP handler answers the role refusal as an error result with the reason intact', async () => {
    const { source } = build(routed(), { role: 'secondary' });
    const { server, tools } = fakeServer();
    registerSourceTools(server, source, { scopes: ['browser:read'], clientId: 'test' });
    const result = await tools.get('ebay_api_search')!({ searchTerm: 'lego', listingType: 'auction' });
    expect(result.isError).toBe(true);
    const payload = errorPayload(result);
    expect(payload.code).toBe('SOURCE_REJECTED');
    expect(payload.details.reason).toBe('secondary_role');
    const admitted = await tools.get('ebay_api_search')!({ searchTerm: 'lego', listingType: 'auction', fallbackReason: 'bridge_unreachable' });
    expect(admitted.isError).toBeUndefined();
  });
});
