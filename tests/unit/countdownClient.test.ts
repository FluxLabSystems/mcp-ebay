/**
 * CountdownClient with an injected fetch (docs/COUNTDOWN-API-PLAN.md §2, §6.2,
 * §6.6): query building, status-code mapping, retries, timeouts, credits, and
 * the guarantee that the API key never leaves the client inside an error.
 */
import { describe, expect, it } from 'vitest';
import { BridgeError } from '@browser-bridge/protocol';
import { CountdownClient } from '@browser-bridge/source-countdown';

const API_KEY = 'sk-live-SECRET123';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

type Responder = (call: FetchCall, attempt: number) => Response | Promise<Response>;

function stubFetch(responder: Responder): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, init };
    calls.push(call);
    return responder(call, calls.length);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const OK_SEARCH = {
  request_info: { success: true, credits_used: 14, credits_remaining: 86, credits_used_this_request: 1 },
  request_metadata: { id: 'req_123', ebay_url: 'https://www.ebay.ca/sch/i.html?_nkw=lego' },
  search_results: [],
  pagination: { current_page: 1, total_results: 0, has_next_page: false },
};

const TRANSIENT_500 = {
  request_info: {
    success: false,
    message:
      'Countdown API was unable to fulfil your request at this time, please retry. You have not been charged for this request. (G)',
  },
};

function client(responder: Responder, extra: Partial<ConstructorParameters<typeof CountdownClient>[0]> = {}) {
  const sleeps: number[] = [];
  const { impl, calls } = stubFetch(responder);
  const instance = new CountdownClient({
    apiKey: API_KEY,
    fetchImpl: impl,
    retryDelaysMs: [0, 0],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { instance, calls, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<BridgeError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    return err as BridgeError;
  }
  throw new Error('expected the request to fail');
}

function assertNoKey(err: BridgeError): void {
  expect(err.message).not.toContain(API_KEY);
  expect(err.message).not.toContain('api_key=');
  const details = JSON.stringify(err.details);
  expect(details).not.toContain(API_KEY);
  expect(details).not.toContain('api_key=');
  expect(JSON.stringify(err.toPayload())).not.toContain(API_KEY);
}

describe('CountdownClient query building', () => {
  it('builds a search query with the vendor parameter names and the key exactly once', async () => {
    const { instance, calls } = client(() => json(200, OK_SEARCH));
    await instance.search({
      ebayDomain: 'ebay.ca',
      searchTerm: 'lego minifigure lot',
      sortBy: 'newly_listed',
      listingType: 'auction',
      condition: 'used',
      categoryId: '183448',
      num: 240,
      page: 1,
      maxPage: 2,
      customerLocation: 'ca',
      customerZipcode: 'M6H 2W9',
      allowRewrittenResults: false,
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe('https://api.countdownapi.com');
    expect(url.pathname).toBe('/request');
    expect(url.searchParams.getAll('api_key')).toEqual([API_KEY]);
    expect(calls[0]!.url.split('api_key=')).toHaveLength(2);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      api_key: API_KEY,
      type: 'search',
      ebay_domain: 'ebay.ca',
      search_term: 'lego minifigure lot',
      sort_by: 'newly_listed',
      listing_type: 'auction',
      condition: 'used',
      category_id: '183448',
      num: '240',
      page: '1',
      max_page: '2',
      customer_location: 'ca',
      customer_zipcode: 'M6H 2W9',
      allow_rewritten_results: 'false',
    });
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes a search url through and omits unset parameters', async () => {
    const { instance, calls } = client(() => json(200, OK_SEARCH));
    await instance.search({ url: 'https://www.ebay.ca/sch/i.html?_ssn=tweedsidesales&_nkw=lego', customerLocation: 'ca', customerZipcode: 'M6H2W9' });
    const params = new URL(calls[0]!.url).searchParams;
    expect(params.get('url')).toBe('https://www.ebay.ca/sch/i.html?_ssn=tweedsidesales&_nkw=lego');
    expect(params.get('customer_zipcode')).toBe('M6H2W9');
    expect(params.has('search_term')).toBe(false);
    expect(params.has('ebay_domain')).toBe(false);
  });

  it('builds product and seller_profile queries and never sends a zip on a product', async () => {
    const { instance, calls } = client(() => json(200, { request_info: { success: true }, product: { title: 'x' } }));
    await instance.product({ url: 'https://www.ebay.ca/itm/331982822376', customerLocation: 'ca', includeHtml: true });
    await instance.product({ ebayDomain: 'ebay.com', epid: '167665350336', customerLocation: 'us' });
    await instance.sellerProfile({ ebayDomain: 'ebay.ca', sellerName: 'The_Brick_World' });
    await instance.sellerProfile({ url: 'https://www.ebay.ca/usr/tweedsidesales' });
    const [byUrl, byEpid, byName, byProfileUrl] = calls.map((call) => Object.fromEntries(new URL(call.url).searchParams));
    expect(byUrl).toEqual({ api_key: API_KEY, type: 'product', url: 'https://www.ebay.ca/itm/331982822376', customer_location: 'ca', include_html: 'true' });
    expect(byEpid).toEqual({ api_key: API_KEY, type: 'product', ebay_domain: 'ebay.com', epid: '167665350336', customer_location: 'us' });
    expect(byName).toEqual({ api_key: API_KEY, type: 'seller_profile', ebay_domain: 'ebay.ca', seller_name: 'The_Brick_World' });
    expect(byProfileUrl).toEqual({ api_key: API_KEY, type: 'seller_profile', url: 'https://www.ebay.ca/usr/tweedsidesales' });
  });

  it('calls the account endpoint with the key only and honours a custom base URL', async () => {
    const { instance, calls } = client(
      () => json(200, { request_info: { success: true }, account_info: { credits_used: 14, credits_remaining: 86 } }),
      { baseUrl: 'http://127.0.0.1:9999/' },
    );
    const result = await instance.account();
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe('http://127.0.0.1:9999');
    expect(url.pathname).toBe('/account');
    expect(Object.fromEntries(url.searchParams)).toEqual({ api_key: API_KEY });
    expect(result.credits).toEqual({ used: 14, remaining: 86, usedThisRequest: null });
  });

  it('refuses an empty key', () => {
    expect(() => new CountdownClient({ apiKey: '' })).toThrow(/apiKey/);
  });
});

describe('CountdownClient results', () => {
  it('returns the body with credits, request id and status', async () => {
    const { instance } = client(() => json(200, OK_SEARCH));
    const result = await instance.search({ searchTerm: 'lego' });
    expect(result.credits).toEqual({ used: 14, remaining: 86, usedThisRequest: 1 });
    expect(result.requestId).toBe('req_123');
    expect(result.httpStatus).toBe(200);
    expect(result.attempts).toBe(1);
    expect(result.body.search_results).toEqual([]);
    expect(result.body.pagination?.total_results).toBe(0);
  });

  it('reports null credits and request id when the vendor omits them (demo key, nulled captures)', async () => {
    const { instance } = client(() =>
      json(200, { request_info: { success: true, demo: true, credits_used: null, credits_remaining: null }, search_results: [] }),
    );
    const result = await instance.search({ searchTerm: 'memory cards' });
    expect(result.credits).toEqual({ used: null, remaining: null, usedThisRequest: null });
    expect(result.requestId).toBeNull();
  });

  it('retries twice on the transient 500 and then succeeds', async () => {
    const { instance, calls, sleeps } = client((_call, attempt) => (attempt < 3 ? json(500, TRANSIENT_500) : json(200, OK_SEARCH)));
    const result = await instance.search({ searchTerm: 'lego' });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([0, 0]);
    expect(result.attempts).toBe(3);
    expect(result.requestId).toBe('req_123');
  });

  it('uses the 2 s / 6 s defaults when no delays are given', async () => {
    const sleeps: number[] = [];
    const { impl } = stubFetch((_call, attempt) => (attempt < 3 ? json(500, TRANSIENT_500) : json(200, OK_SEARCH)));
    const instance = new CountdownClient({
      apiKey: API_KEY,
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await instance.search({ searchTerm: 'lego' });
    expect(sleeps).toEqual([2000, 6000]);
  });
});

describe('CountdownClient error mapping', () => {
  it('maps 400 and 401 to SOURCE_REJECTED with the vendor message, key redacted', async () => {
    const rejected = client(() => json(400, { request_info: { success: false, message: `customer_zipcode should not be specified when type=product (key ${API_KEY})` } }));
    const err400 = await failure(rejected.instance.product({ url: 'https://www.ebay.ca/itm/1' }));
    expect(err400.code).toBe('SOURCE_REJECTED');
    expect(err400.retryable).toBe(false);
    expect(err400.message).toContain('customer_zipcode should not be specified');
    expect(err400.message).toContain('[REDACTED]');
    expect(err400.details).toMatchObject({ status: 400, requestType: 'product', attempts: 1 });
    expect(err400.details.vendorMessage).toContain('[REDACTED]');
    assertNoKey(err400);
    expect(rejected.calls).toHaveLength(1);

    const unauthorized = client(() => json(401, { request_info: { success: false, message: 'Invalid API key' } }));
    const err401 = await failure(unauthorized.instance.search({ searchTerm: 'lego' }));
    expect(err401.code).toBe('SOURCE_REJECTED');
    expect(err401.message).toContain('Invalid API key');
    assertNoKey(err401);
    expect(unauthorized.calls).toHaveLength(1);
  });

  it('maps 402 to SOURCE_CREDITS_EXHAUSTED without retrying', async () => {
    const { instance, calls } = client(() => json(402, { request_info: { success: false, message: 'Out of credits' } }));
    const err = await failure(instance.search({ searchTerm: 'lego' }));
    expect(err.code).toBe('SOURCE_CREDITS_EXHAUSTED');
    expect(err.retryable).toBe(false);
    expect(err.details.status).toBe(402);
    assertNoKey(err);
    expect(calls).toHaveLength(1);
  });

  it('maps 429 to RATE_LIMITED with the Retry-After header', async () => {
    const { instance, calls } = client(() => json(429, { request_info: { success: false, message: 'Too many requests' } }, { 'retry-after': '10' }));
    const err = await failure(instance.search({ searchTerm: 'lego' }));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.details).toMatchObject({ status: 429, retryAfter: 10 });
    assertNoKey(err);
    expect(calls).toHaveLength(1);
  });

  it('maps 503 to SOURCE_UNAVAILABLE carrying retry_after from the body', async () => {
    const { instance, calls } = client(() => json(503, { request_info: { success: false, message: 'Parsing incident' }, retry_after: 45 }));
    const err = await failure(instance.search({ searchTerm: 'lego' }));
    expect(err.code).toBe('SOURCE_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.details).toMatchObject({ status: 503, retryAfter: 45, reason: 'incident', attempts: 3 });
    expect(err.message).toContain('Parsing incident');
    assertNoKey(err);
    expect(calls).toHaveLength(3);
  });

  it('maps a 500 that never clears to SOURCE_UNAVAILABLE after the retry budget', async () => {
    const { instance, calls } = client(() => json(500, TRANSIENT_500));
    const err = await failure(instance.search({ searchTerm: 'lego' }));
    expect(err.code).toBe('SOURCE_UNAVAILABLE');
    expect(err.details).toMatchObject({ status: 500, attempts: 3, reason: 'server_error' });
    expect(err.message).toContain('(G)');
    assertNoKey(err);
    expect(calls).toHaveLength(3);
  });

  it('maps a timeout to SOURCE_UNAVAILABLE after retries', async () => {
    const { instance, calls } = client(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }, { timeoutMs: 1234 });
    const err = await failure(instance.product({ url: 'https://www.ebay.ca/itm/1' }));
    expect(err.code).toBe('SOURCE_UNAVAILABLE');
    expect(err.details).toMatchObject({ reason: 'timeout', timeoutMs: 1234, attempts: 3 });
    expect(err.message).toContain('timed out');
    assertNoKey(err);
    expect(calls).toHaveLength(3);
  });

  it('maps a network failure to SOURCE_UNAVAILABLE and redacts a key embedded in the cause', async () => {
    const { instance, calls } = client((call) => {
      throw new TypeError(`fetch failed: ${call.url}`);
    });
    const err = await failure(instance.search({ searchTerm: 'lego' }));
    expect(err.code).toBe('SOURCE_UNAVAILABLE');
    expect(err.details).toMatchObject({ reason: 'network', attempts: 3 });
    expect(err.message).toContain('[REDACTED]');
    expect(String(err.details.cause)).toContain('[REDACTED]');
    assertNoKey(err);
    expect(calls).toHaveLength(3);
  });

  it('maps a non-JSON body to SOURCE_UNAVAILABLE', async () => {
    const { instance, calls } = client(() => new Response('<html>Bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const err = await failure(instance.search({ searchTerm: 'lego' }));
    expect(err.code).toBe('SOURCE_UNAVAILABLE');
    expect(err.details).toMatchObject({ reason: 'non_json', status: 200 });
    expect(err.details.bodySnippet).toContain('Bad gateway');
    assertNoKey(err);
    expect(calls).toHaveLength(1);
  });

  it('maps a 200 with request_info.success false to SOURCE_REJECTED', async () => {
    const { instance } = client(() => json(200, { request_info: { success: false, message: 'Unsupported domain' } }));
    const err = await failure(instance.search({ searchTerm: 'lego' }));
    expect(err.code).toBe('SOURCE_REJECTED');
    expect(err.message).toContain('Unsupported domain');
    assertNoKey(err);
  });

  it('maps a body that violates the schema to EXTRACTION_INCOMPLETE naming the path', async () => {
    const { instance } = client(() => json(200, { request_info: { success: true }, search_results: 'nope' }));
    const err = await failure(instance.search({ searchTerm: 'lego' }));
    expect(err.code).toBe('EXTRACTION_INCOMPLETE');
    expect(err.message).toContain('search_results');
    expect(err.details).toMatchObject({ path: 'search_results', requestType: 'search' });
    assertNoKey(err);
  });
});
