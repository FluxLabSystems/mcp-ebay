/**
 * Countdown API source end to end: OAuth-verified MCP call → gateway-served
 * ebay_api_* tool → stubbed vendor serving the Phase 0 fixtures. No Windows
 * device is on this path, and the vendor key must appear only in the
 * gateway's outbound query string — never in tool input, output or an
 * audit row (docs/COUNTDOWN-API-PLAN.md §2 Security, §6.6). The vendor's
 * free account endpoint is stubbed too: the reserve gate reads it before
 * the first charged request, and ebay_api_status reads it on every call.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtTokenVerifier } from '@browser-bridge/gateway';
import {
  EbayApiItemsOutput,
  EbayApiSearchOutput,
  EbayApiSellerOutput,
  EbayApiStatusOutput,
  ExtractManyOutput,
  SOURCE_TOOL_CATALOG,
} from '@browser-bridge/protocol';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

const ISSUER = 'https://idp.test.example/realms/fluxology';
const AUDIENCE = 'https://browser-mcp.test.example/mcp';
const API_KEY = 'cd-integration-SECRET-key';
const BUILD_SHA = '03acf1d';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'countdown');
const SOURCE_TOOL_NAMES = SOURCE_TOOL_CATALOG.map((entry) => entry.name);
const CHARGED_TOOL_NAMES = SOURCE_TOOL_CATALOG.filter((entry) => entry.spendsCredits).map((entry) => entry.name);

type Json = Record<string, unknown>;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Json;
}

let privateKey: CryptoKey;
let harness: GatewayHarness;
let vendorSeq = 0;
const vendorRequests: { url: URL; query: URLSearchParams }[] = [];

/** The stubbed account: a Starter plan part-way through its month. */
const ACCOUNT = { plan: 'starter', creditsLimit: 10_000, creditsUsed: 640, creditsRemaining: 9_360, resetAt: '2026-10-01T00:00:00Z' };

async function mintToken(scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope, client_id: 'claude-ai' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('user-1')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

/**
 * The captured fixtures have their credit counters nulled; the stub reports
 * the counters, the per-request figure and an id on every response. (The
 * live vendor sent no request_metadata.id on any 2026-09-02 response, so
 * requestIds is empty there; the field stays for when it does.)
 */
function served(body: Json): Response {
  vendorSeq += 1;
  const withCredits = {
    ...body,
    request_info: {
      ...(body.request_info as Json),
      credits_used: ACCOUNT.creditsUsed + vendorSeq,
      credits_remaining: ACCOUNT.creditsRemaining - vendorSeq,
      credits_used_this_request: 1,
    },
    request_metadata: { ...((body.request_metadata as Json | undefined) ?? {}), id: `req_${vendorSeq}` },
  };
  return new Response(JSON.stringify(withCredits), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** The free account endpoint, echoing the key and the email the way the vendor does. */
function accountResponse(overrides: Partial<typeof ACCOUNT> = {}, apiKey = API_KEY): Response {
  const account = { ...ACCOUNT, ...overrides };
  const body = {
    request_info: { success: true },
    request_metadata: { id: `acct_${(vendorSeq += 1)}` },
    account_info: {
      api_key: apiKey,
      name: 'Integration',
      email: 'integration@example.com',
      plan: account.plan,
      credits_used: account.creditsUsed,
      credits_limit: account.creditsLimit,
      credits_remaining: account.creditsRemaining,
      credits_reset_at: account.resetAt,
    },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function parseVendorRequest(input: RequestInfo | URL): { url: URL; query: URLSearchParams } {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  return { url, query: url.searchParams };
}

const stubVendor: typeof fetch = (async (input: RequestInfo | URL) => {
  const { url, query } = parseVendorRequest(input);
  vendorRequests.push({ url, query });
  if (query.get('api_key') !== API_KEY) {
    return new Response(JSON.stringify({ request_info: { success: false, message: 'Invalid API key' } }), { status: 401 });
  }
  if (url.pathname === '/account') return accountResponse();
  const type = query.get('type');
  if (type === 'search') {
    const target = query.get('url');
    if (target !== null) return served(fixture('keyed/search-ca-seller-ssn-tweedsidesales.json'));
    if (query.get('listing_type') === 'auction') return served(fixture('keyed/search-ca-lego-minifig-auction-newly-listed.json'));
    if (query.get('listing_type') === 'buy_it_now') return served(fixture('keyed/search-ca-lego-minifig-newly-listed.json'));
    return new Response(JSON.stringify({ request_info: { success: false, message: 'unfiltered search issued' } }), { status: 400 });
  }
  if (type === 'product') {
    const itemId = /\/itm\/(\d+)/.exec(query.get('url') ?? '')?.[1] ?? null;
    if (itemId === '287557851282') return served(fixture('keyed/product-ca-287557851282.json'));
    if (itemId === '168658364834') return served(fixture('keyed/product-ca-168658364834-live-auction.json'));
    if (itemId === '233599133856') return served(fixture('demo/product-not-found-ca.json'));
    return new Response(JSON.stringify({ request_info: { success: false, message: `no fixture for ${itemId}` } }), { status: 400 });
  }
  if (type === 'seller_profile') return served(fixture('keyed/seller-profile-ca-usr-tweedsidesales.json'));
  return new Response(JSON.stringify({ request_info: { success: false, message: 'unexpected request type' } }), { status: 400 });
}) as typeof fetch;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk = (await exportJWK(pair.publicKey)) as JWK;
  publicJwk.alg = 'ES256';
  const verifier = new JwtTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: 'https://idp.test.example/.well-known/jwks.json',
    jwks: createLocalJWKSet({ keys: [publicJwk] }) as never,
  });
  harness = buildGatewayHarness({ verifier, countdownApiKey: API_KEY, countdownFetch: stubVendor, env: { GATEWAY_BUILD_SHA: BUILD_SHA } });
});
afterAll(async () => {
  await harness?.close();
});

function clientWith(token: string): ModernMcpClient {
  return new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch, token);
}

function errorOf(response: { body: { result?: { content?: Array<{ text?: string }> } } }): { code: string; message: string; details?: Json } | undefined {
  const text = response.body.result?.content?.[0]?.text ?? '{}';
  return (JSON.parse(text) as { error?: { code: string; message: string; details?: Json } }).error;
}

describe('ebay_api_* tools over the live MCP surface', () => {
  it('lists the four source tools for a browser:read token, with honest annotations', async () => {
    const response = await clientWith(await mintToken('browser:read')).listTools();
    expect(response.status).toBe(200);
    const tools = response.body.result?.tools as { name: string; annotations?: Record<string, unknown>; description?: string }[];
    const names = tools.map((tool) => tool.name);
    for (const name of SOURCE_TOOL_NAMES) expect(names).toContain(name);
    for (const tool of tools.filter((entry) => SOURCE_TOOL_NAMES.includes(entry.name))) {
      // A charged call is not free to repeat; the account probe is.
      const spendsCredits = CHARGED_TOOL_NAMES.includes(tool.name);
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: !spendsCredits, openWorldHint: true });
      expect(tool.description, tool.name).toContain('Requires scope browser:read');
    }
    expect(vendorRequests).toHaveLength(0);
  });

  it('reads the account budget with ebay_api_status: a free probe, the plan, the reserve, the gate and the build', async () => {
    const before = vendorRequests.length;
    const response = await clientWith(await mintToken('browser:read')).callTool('ebay_api_status', {});
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).not.toBe(true);
    const structured = EbayApiStatusOutput.parse(response.body.result?.structuredContent);
    expect(structured).toMatchObject({
      source: 'countdown',
      siteProfile: 'ebay.api.v1',
      probe: { ok: true, httpStatus: 200, error: null },
      plan: { name: 'starter', creditsLimit: 10_000, creditsResetAt: '2026-10-01T00:00:00Z' },
      account: { suspended: false, vendorMessage: null },
      credits: { used: 640, remaining: 9_360 },
      // The default reserve: 5% of the plan limit.
      reserve: { configured: '5%', effective: 500, basis: 'plan_limit' },
      gate: { open: true, reason: null, spendable: 8_860 },
      build: { gateway: BUILD_SHA },
      warnings: [],
    });
    expect(Date.parse(structured.probedAt)).not.toBeNaN();
    // Exactly one vendor call, to the free endpoint; nothing charged.
    const upstream = vendorRequests.slice(before);
    expect(upstream.map((request) => request.url.pathname)).toEqual(['/account']);
    expect(upstream[0]!.query.get('api_key')).toBe(API_KEY);
    // The vendor echoed the key and the email; neither reaches the caller.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('integration@example.com');
    expect(serialized).not.toContain('api_key');
  });

  it('serves a split search from the keyed fixtures; the key rides only in the outbound query', async () => {
    const before = vendorRequests.length;
    const response = await clientWith(await mintToken('browser:read')).callTool('ebay_api_search', {
      searchTerm: 'lego minifigure lot',
      sortBy: 'newly_listed',
      destination: 'toronto',
      search: { limit: 50 },
    });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).not.toBe(true);
    const structured = EbayApiSearchOutput.parse(response.body.result?.structuredContent);
    expect(structured).toMatchObject({ source: 'countdown', siteProfile: 'ebay.api.v1', pageKind: 'search', domain: 'ebay.ca', destination: 'toronto' });
    expect(structured.retrievedUnder).toEqual(['buy_it_now', 'auction']);
    expect(structured.pageUrl).toContain('_stpos=M6H2W9');
    expect(structured.candidateCount).toBeGreaterThan(240);
    expect(structured.candidates).toHaveLength(50);
    expect(structured.hasMore).toBe(true);
    expect(structured.nextOffset).toBe(50);
    expect(structured.credits.remaining).not.toBeNull();
    // Two vendor requests, two credits; used is the account total, not the call's spend.
    expect(structured.credits.usedThisRequest).toBe(2);
    expect(structured.requestIds).toHaveLength(2);
    expect(structured.warnings.some((warning) => warning.startsWith('CREDIT_RESERVE_UNRESOLVED:'))).toBe(false);
    // The auction twin proves the 30 shared rows are auctions with a BIN.
    const formats = new Set(structured.candidates.map((candidate) => candidate.sellingFormat));
    expect(formats.has('fixed_price')).toBe(true);
    expect(formats.has('auction_with_bin')).toBe(true);

    // The status call above left the balance known, so no probe precedes
    // the two charged requests.
    const upstream = vendorRequests.slice(before);
    expect(upstream).toHaveLength(2);
    expect(upstream.map((request) => request.query.get('listing_type')).sort()).toEqual(['auction', 'buy_it_now']);
    for (const request of upstream) {
      expect(request.url.origin).toBe('https://api.countdownapi.com');
      expect(request.url.pathname).toBe('/request');
      expect(request.query.get('api_key')).toBe(API_KEY);
      expect(request.query.get('customer_location')).toBe('ca');
      expect(request.query.get('customer_zipcode')).toBe('M6H2W9');
    }
    expect(JSON.stringify(response.body)).not.toContain(API_KEY);
  });

  it('forwards a seller-scoped /sch/ URL to the vendor with the routine conventions intact', async () => {
    const before = vendorRequests.length;
    const response = await clientWith(await mintToken('browser:read')).callTool('ebay_api_search', {
      url: 'https://www.ebay.ca/sch/i.html?_ssn=tweedsidesales&_nkw=lego&_sop=10&_ipg=240',
      destination: 'toronto',
    });
    expect(response.body.result?.isError).not.toBe(true);
    const structured = EbayApiSearchOutput.parse(response.body.result?.structuredContent);
    expect(structured.candidateCount).toBeGreaterThan(0);
    const upstream = vendorRequests.slice(before);
    expect(upstream).toHaveLength(2);
    for (const request of upstream) {
      const target = new URL(request.query.get('url')!);
      expect(target.host).toBe('www.ebay.ca');
      expect(target.searchParams.get('_ssn')).toBe('tweedsidesales');
      expect(target.searchParams.get('_sop')).toBe('10');
      expect(target.searchParams.get('_ipg')).toBe('240');
    }
  });

  it('reads items in browser_extract_many shape; minus the source fields it is a valid ExtractManyOutput', async () => {
    const before = vendorRequests.length;
    const response = await clientWith(await mintToken('browser:read')).callTool('ebay_api_items', {
      items: [
        { itemId: '287557851282', expectedFormat: 'fixed_price' },
        { itemId: '168658364834', expectedFormat: 'auction' },
        { itemId: '233599133856' },
      ],
      destination: 'toronto',
    });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).not.toBe(true);
    const structured = EbayApiItemsOutput.parse(response.body.result?.structuredContent);
    expect(structured).toMatchObject({ source: 'countdown', mode: 'inline', jobId: null, status: 'completed', requested: 3, completed: 3, succeeded: 2, failed: 1, compact: true, resultsFrom: 0 });
    expect(structured.requestIds).toHaveLength(3);
    // Three charged responses, the dead listing's included.
    expect(structured.credits.usedThisRequest).toBe(3);

    const [fixed, auction, gone] = structured.results;
    expect(fixed).toMatchObject({ url: 'https://www.ebay.ca/itm/287557851282', ok: true, siteProfile: 'ebay.api.v1', pageRevision: 0, error: null });
    expect((fixed!.record as { itemId: string; itemPrice: { value: number; currency: string } }).itemPrice).toEqual({ value: 15, currency: 'CAD' });
    expect(fixed!.warnings.some((warning) => warning.startsWith('DESTINATION_UNVERIFIED:'))).toBe(true);

    expect(auction!.ok).toBe(true);
    expect((auction!.record as { sellingFormat: { kind: string }; itemPrice: unknown }).sellingFormat.kind).toBe('auction');
    expect((auction!.record as { itemPrice: { value: number | null } | null }).itemPrice?.value ?? null).toBeNull();
    expect(auction!.warnings.some((warning) => warning.startsWith('AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE:'))).toBe(true);

    expect(gone!.ok).toBe(false);
    expect(gone!.error).toMatchObject({ code: 'LISTING_UNAVAILABLE', retryable: false });
    expect(gone!.record).not.toBeNull();

    const { source: _source, credits: _credits, requestIds: _requestIds, ...bridgeShape } = structured;
    expect(ExtractManyOutput.parse(bridgeShape)).toBeTruthy();

    const upstream = vendorRequests.slice(before);
    expect(upstream).toHaveLength(3);
    for (const request of upstream) {
      expect(request.query.get('type')).toBe('product');
      expect(request.query.get('customer_location')).toBe('ca');
      expect(request.query.has('customer_zipcode')).toBe(false);
      expect(request.query.get('api_key')).toBe(API_KEY);
    }
    expect(JSON.stringify(response.body)).not.toContain(API_KEY);
  });

  it('confirms a seller by login id', async () => {
    const response = await clientWith(await mintToken('browser:read')).callTool('ebay_api_seller', { loginId: 'tweedsidesales' });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).not.toBe(true);
    const structured = EbayApiSellerOutput.parse(response.body.result?.structuredContent);
    expect(structured.resolved).toBe(true);
    expect(structured.seller).toMatchObject({
      name: 'Jeremy Doherty',
      loginId: 'tweedsidesales',
      storeSlug: 'jeremydoherty',
      positivePercent: 99.8,
      followers: '79 followers',
    });
    expect(structured.requestIds).toHaveLength(1);
    expect(structured.credits.usedThisRequest).toBe(1);
    // The keyed capture carries no member_since, location, top_rated_seller
    // or description; the warning is what tells omission from absence.
    expect(structured.warnings).toContain(
      'SELLER_FIELDS_ABSENT_FROM_SOURCE: the vendor returned no member-since, location, top-rated or description for this profile',
    );
    expect(vendorRequests.at(-1)?.query.get('url')).toBe('https://www.ebay.ca/usr/tweedsidesales');
    expect(JSON.stringify(response.body)).not.toContain(API_KEY);
  });

  it('writes one audit row per upstream call, the free probe included, and none carries the key or the outbound URL', () => {
    const rows = harness.store.audit.events.filter((event) => SOURCE_TOOL_NAMES.includes(event.toolName ?? ''));
    expect(rows).toHaveLength(vendorRequests.length);
    for (const row of rows) {
      expect(row.actionClass).toBe('source');
      expect(row.userSubject).toBe('user-1');
      expect(row.outcome).toBe('ok');
      expect(row.metadata).toMatchObject({ source: 'countdown' });
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).not.toContain('countdownapi.com');
      expect(serialized).not.toContain('integration@example.com');
    }
    const probes = rows.filter((row) => (row.metadata as { requestType?: unknown }).requestType === 'account');
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ toolName: 'ebay_api_status', requestId: expect.stringMatching(/^acct_\d+$/) });
    expect(probes[0]!.metadata).toMatchObject({ probe: true, trigger: 'status', creditsUsedThisRequest: null, creditsLimit: 10_000, plan: 'starter' });
    for (const row of rows.filter((entry) => !probes.includes(entry))) {
      expect(row.requestId).toMatch(/^req_\d+$/);
      expect(row.metadata).toMatchObject({ creditsUsedThisRequest: 1 });
    }
  });

  it('refuses a token without browser:read with ACTION_BLOCKED before any vendor call', async () => {
    const before = vendorRequests.length;
    const client = clientWith(await mintToken('dashboards:read'));
    for (const [tool, args] of [
      ['ebay_api_search', { searchTerm: 'lego' }],
      ['ebay_api_status', {}],
    ] as const) {
      const response = await client.callTool(tool, args);
      expect(response.status).toBe(200);
      expect(response.body.result?.isError, tool).toBe(true);
      const error = errorOf(response);
      expect(error?.code, tool).toBe('ACTION_BLOCKED');
      expect(error?.message, tool).toContain('browser:read');
    }
    expect(vendorRequests).toHaveLength(before);
  });

  it('refuses a schema-invalid call before any vendor call', async () => {
    const before = vendorRequests.length;
    const client = clientWith(await mintToken('browser:read'));
    const response = await client.callTool('ebay_api_search', {
      searchTerm: 'lego',
      url: 'https://www.ebay.ca/sch/i.html?_nkw=lego',
    });
    expect(response.body.result?.isError).toBe(true);
    const status = await client.callTool('ebay_api_status', { refresh: true });
    expect(status.body.result?.isError).toBe(true);
    expect(vendorRequests).toHaveLength(before);
  });

  it('registers none of the source tools when COUNTDOWN_API_KEY is unset', async () => {
    const unconfigured = buildGatewayHarness();
    try {
      const response = await new ModernMcpClient('https://browser-mcp.test.example/mcp', unconfigured.fetch).listTools();
      expect(response.status).toBe(200);
      const names = (response.body.result?.tools ?? []).map((tool) => tool.name);
      for (const name of SOURCE_TOOL_NAMES) expect(names).not.toContain(name);
    } finally {
      await unconfigured.close();
    }
  });
});

describe('the credit reserve gate over the live MCP surface (the 2026-09-03 zero-coverage fire)', () => {
  /** A gateway against the trial account: plan "free", a one-time 100, 82 left. */
  function trialHarness(reserve: string, remaining: number) {
    const calls: string[] = [];
    const key = `cd-trial-${reserve.replace('%', 'pct')}-key`;
    const vendor: typeof fetch = (async (input: RequestInfo | URL) => {
      const { url, query } = parseVendorRequest(input);
      calls.push(url.pathname);
      if (url.pathname === '/account') return accountResponse({ plan: 'free', creditsLimit: 100, creditsUsed: 100 - remaining, creditsRemaining: remaining, resetAt: null as unknown as string }, key);
      if (query.get('type') === 'seller_profile') return served(fixture('keyed/seller-profile-ca-usr-tweedsidesales.json'));
      return new Response(JSON.stringify({ request_info: { success: false, message: 'a charged request went out' } }), { status: 400 });
    }) as typeof fetch;
    const gateway = buildGatewayHarness({ countdownApiKey: key, countdownFetch: vendor, env: { COUNTDOWN_CREDIT_RESERVE: reserve } });
    const client = new ModernMcpClient('https://browser-mcp.test.example/mcp', gateway.fetch);
    return { gateway, client, calls };
  }

  it('refuses the first search and item call against an absolute reserve the plan can never satisfy, naming the fix, and still confirms a seller', async () => {
    const { gateway, client, calls } = trialHarness('500', 82);
    try {
      const search = await client.callTool('ebay_api_search', { searchTerm: 'lego minifigure lot', domain: 'ebay.ca', destination: 'toronto', listingType: 'buy_it_now' });
      expect(search.body.result?.isError).toBe(true);
      const searchError = errorOf(search)!;
      expect(searchError.code).toBe('SOURCE_CREDITS_EXHAUSTED');
      expect(searchError.message).toBe(
        'COUNTDOWN_CREDIT_RESERVE=500 is not below the plan\'s 100-credit limit (plan "free"); set it below the limit or to a percentage such as 5%. search calls are refused until it is (seller lookups still run).',
      );
      expect(searchError.details).toEqual({
        gate: true,
        reason: 'reserve_not_below_plan_limit',
        kind: 'search',
        creditReserve: 500,
        creditsLimit: 100,
        creditsRemaining: 82,
        plan: 'free',
        reserveConfigured: '500',
      });
      // The free read came first and nothing charged went out.
      expect(calls).toEqual(['/account']);

      const items = await client.callTool('ebay_api_items', { items: [{ itemId: '236674561036' }] });
      expect(errorOf(items)?.details).toMatchObject({ reason: 'reserve_not_below_plan_limit', kind: 'items' });
      expect(calls).toEqual(['/account']);

      const seller = await client.callTool('ebay_api_seller', { loginId: 'tweedsidesales' });
      expect(seller.body.result?.isError).not.toBe(true);
      expect(EbayApiSellerOutput.parse(seller.body.result?.structuredContent).resolved).toBe(true);
      expect(calls).toEqual(['/account', '/request']);

      const status = await client.callTool('ebay_api_status', {});
      const structured = EbayApiStatusOutput.parse(status.body.result?.structuredContent);
      expect(structured.reserve).toEqual({ configured: '500', effective: 500, basis: 'absolute' });
      expect(structured.gate).toEqual({ open: false, reason: 'reserve_not_below_plan_limit', spendable: 0 });
      expect(structured.warnings[0]).toMatch(/^RESERVE_NOT_BELOW_PLAN_LIMIT: COUNTDOWN_CREDIT_RESERVE=500 is not below the plan's 100-credit limit/);
      expect(JSON.stringify(status.body)).not.toContain('cd-trial-500-key');
    } finally {
      await gateway.close();
    }
  });

  it('refuses a search below a percent reserve of the plan limit, naming the balance, the reserve and its basis', async () => {
    const { gateway, client, calls } = trialHarness('5%', 4);
    try {
      const search = await client.callTool('ebay_api_search', { searchTerm: 'lego', listingType: 'auction' });
      expect(search.body.result?.isError).toBe(true);
      const error = errorOf(search)!;
      expect(error.code).toBe('SOURCE_CREDITS_EXHAUSTED');
      expect(error.message).toBe(
        "Countdown API credit reserve reached: 4 credit(s) remain, below the reserve of 5 (5% of the plan's 100-credit limit); search calls are refused until the balance is topped up (seller lookups still run).",
      );
      expect(error.details).toEqual({
        gate: true,
        reason: 'below_reserve',
        kind: 'search',
        creditsRemaining: 4,
        creditsLimit: 100,
        plan: 'free',
        creditReserve: 5,
        reserveConfigured: '5%',
      });
      expect(calls).toEqual(['/account']);
      const status = await client.callTool('ebay_api_status', {});
      expect(EbayApiStatusOutput.parse(status.body.result?.structuredContent).gate).toEqual({ open: false, reason: 'below_reserve', spendable: 0 });
    } finally {
      await gateway.close();
    }
  });

  it('a vendor suspension is SOURCE_REJECTED with the fix, then refused from memory for every tool without contacting the vendor', async () => {
    // The 2026-09-03T11:27Z manual fire: one seller lookup answered, then
    // the vendor suspended the trial account and every call answered 402
    // with this notice; the routine was told to top up, which cannot help.
    const notice =
      'Your account has been temporarily suspended as our systems detected multiple Free Trial accounts being active, or a disposable email address being used during signup. This suspension will automatically be removed when you subscribe to a Plan.';
    const calls: string[] = [];
    const key = 'cd-suspended-key';
    const vendor: typeof fetch = (async (input: RequestInfo | URL) => {
      const { url } = parseVendorRequest(input);
      calls.push(url.pathname);
      if (url.pathname === '/account') return accountResponse({ plan: 'free', creditsLimit: 100, creditsUsed: 20, creditsRemaining: 80, resetAt: null as unknown as string }, key);
      return new Response(JSON.stringify({ request_info: { success: false, message: notice } }), { status: 402, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const gateway = buildGatewayHarness({ countdownApiKey: key, countdownFetch: vendor });
    const client = new ModernMcpClient('https://browser-mcp.test.example/mcp', gateway.fetch);
    try {
      const seller = await client.callTool('ebay_api_seller', { loginId: 'tweedsidesales' });
      expect(seller.body.result?.isError).toBe(true);
      const first = errorOf(seller)!;
      expect(first.code).toBe('SOURCE_REJECTED');
      expect(first.message).toBe(`Countdown API account suspended (HTTP 402): ${notice}`);
      expect(first.details).toMatchObject({ reason: 'account_suspended', httpStatus: 402, vendorMessage: notice });
      expect(calls).toEqual(['/request']);

      for (const [tool, args] of [
        ['ebay_api_search', { searchTerm: 'lego', listingType: 'auction' }],
        ['ebay_api_items', { items: [{ itemId: '236674561036' }] }],
        ['ebay_api_seller', { loginId: 'tweedsidesales' }],
      ] as const) {
        const response = await client.callTool(tool, args);
        expect(response.body.result?.isError, tool).toBe(true);
        const error = errorOf(response)!;
        expect(error.code, tool).toBe('SOURCE_REJECTED');
        expect(error.details, tool).toMatchObject({ reason: 'account_suspended', remembered: true, httpStatus: 402, vendorMessage: notice });
        expect(error.message, tool).toContain('No top-up lifts a suspension');
      }
      expect(calls).toEqual(['/request']);

      const status = await client.callTool('ebay_api_status', {});
      expect(status.body.result?.isError).not.toBe(true);
      const structured = EbayApiStatusOutput.parse(status.body.result?.structuredContent);
      expect(structured.probe.ok).toBe(true);
      expect(structured.account).toEqual({ suspended: true, vendorMessage: notice });
      expect(structured.gate).toEqual({ open: false, reason: 'account_suspended', spendable: 0 });
      expect(structured.warnings[0]).toMatch(/^ACCOUNT_SUSPENDED: /);
      expect(calls).toEqual(['/request', '/account']);
      expect(JSON.stringify(status.body)).not.toContain(key);
    } finally {
      await gateway.close();
    }
  });

  it('admits the trial account under the default reserve: 5% of 100 is 5, and 82 remain', async () => {
    const { gateway, client, calls } = trialHarness('5%', 82);
    try {
      const status = await client.callTool('ebay_api_status', {});
      const structured = EbayApiStatusOutput.parse(status.body.result?.structuredContent);
      expect(structured.plan).toEqual({ name: 'free', creditsLimit: 100, creditsResetAt: null });
      expect(structured.credits).toEqual({ used: 18, remaining: 82 });
      expect(structured.reserve).toEqual({ configured: '5%', effective: 5, basis: 'plan_limit' });
      expect(structured.gate).toEqual({ open: true, reason: null, spendable: 77 });
      // The search goes upstream now (the stub answers it 400: the point is
      // that it was sent, after the probe the status call already made).
      const search = await client.callTool('ebay_api_search', { searchTerm: 'lego', listingType: 'auction' });
      expect(errorOf(search)?.code).toBe('SOURCE_REJECTED');
      expect(calls).toEqual(['/account', '/request']);
    } finally {
      await gateway.close();
    }
  });
});
