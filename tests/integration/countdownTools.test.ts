/**
 * Countdown API source end to end: OAuth-verified MCP call → gateway-served
 * ebay_api_* tool → stubbed vendor serving the Phase 0 fixtures. No Windows
 * device is on this path, and the vendor key must appear only in the
 * gateway's outbound query string — never in tool input, output or an
 * audit row (docs/COUNTDOWN-API-PLAN.md §2 Security, §6.6).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtTokenVerifier } from '@browser-bridge/gateway';
import { EbayApiItemsOutput, EbayApiSearchOutput, EbayApiSellerOutput, ExtractManyOutput, SOURCE_TOOL_CATALOG } from '@browser-bridge/protocol';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

const ISSUER = 'https://idp.test.example/realms/fluxology';
const AUDIENCE = 'https://browser-mcp.test.example/mcp';
const API_KEY = 'cd-integration-SECRET-key';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'countdown');
const SOURCE_TOOL_NAMES = SOURCE_TOOL_CATALOG.map((entry) => entry.name);

type Json = Record<string, unknown>;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Json;
}

let privateKey: CryptoKey;
let harness: GatewayHarness;
let vendorSeq = 0;
const vendorRequests: { url: URL; query: URLSearchParams }[] = [];

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

/** The captured fixtures have their credit counters nulled; a live vendor reports them and an id on every response. */
function served(body: Json): Response {
  vendorSeq += 1;
  const withCredits = {
    ...body,
    request_info: { ...(body.request_info as Json), credits_used: 14 + vendorSeq, credits_remaining: 986 - vendorSeq, credits_used_this_request: 1 },
    request_metadata: { ...((body.request_metadata as Json | undefined) ?? {}), id: `req_${vendorSeq}` },
  };
  return new Response(JSON.stringify(withCredits), { status: 200, headers: { 'content-type': 'application/json' } });
}

const stubVendor: typeof fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  const query = url.searchParams;
  vendorRequests.push({ url, query });
  if (query.get('api_key') !== API_KEY) {
    return new Response(JSON.stringify({ request_info: { success: false, message: 'Invalid API key' } }), { status: 401 });
  }
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
  harness = buildGatewayHarness({ verifier, countdownApiKey: API_KEY, countdownFetch: stubVendor });
});
afterAll(async () => {
  await harness?.close();
});

function clientWith(token: string): ModernMcpClient {
  return new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch, token);
}

function errorOf(response: { body: { result?: { content?: Array<{ text?: string }> } } }): { code: string; message: string } | undefined {
  const text = response.body.result?.content?.[0]?.text ?? '{}';
  return (JSON.parse(text) as { error?: { code: string; message: string } }).error;
}

describe('ebay_api_* tools over the live MCP surface', () => {
  it('lists the three source tools for a browser:read token, with honest annotations', async () => {
    const response = await clientWith(await mintToken('browser:read')).listTools();
    expect(response.status).toBe(200);
    const tools = response.body.result?.tools as { name: string; annotations?: Record<string, unknown>; description?: string }[];
    const names = tools.map((tool) => tool.name);
    for (const name of SOURCE_TOOL_NAMES) expect(names).toContain(name);
    for (const tool of tools.filter((entry) => SOURCE_TOOL_NAMES.includes(entry.name))) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
      expect(tool.description, tool.name).toContain('Requires scope browser:read');
    }
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
    expect(structured.requestIds).toHaveLength(2);
    // The auction twin proves the 30 shared rows are auctions with a BIN.
    const formats = new Set(structured.candidates.map((candidate) => candidate.sellingFormat));
    expect(formats.has('fixed_price')).toBe(true);
    expect(formats.has('auction_with_bin')).toBe(true);

    const upstream = vendorRequests.slice(before);
    expect(upstream).toHaveLength(2);
    expect(upstream.map((request) => request.query.get('listing_type')).sort()).toEqual(['auction', 'buy_it_now']);
    for (const request of upstream) {
      expect(request.url.origin).toBe('https://api.countdownapi.com');
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
    expect(vendorRequests.at(-1)?.query.get('url')).toBe('https://www.ebay.ca/usr/tweedsidesales');
    expect(JSON.stringify(response.body)).not.toContain(API_KEY);
  });

  it('writes one audit row per upstream call, and none carries the key or the outbound URL', () => {
    const rows = harness.store.audit.events.filter((event) => SOURCE_TOOL_NAMES.includes(event.toolName ?? ''));
    expect(rows).toHaveLength(vendorRequests.length);
    for (const row of rows) {
      expect(row.actionClass).toBe('source');
      expect(row.userSubject).toBe('user-1');
      expect(row.outcome).toBe('ok');
      expect(row.requestId).toMatch(/^req_\d+$/);
      expect(row.metadata).toMatchObject({ source: 'countdown', creditsUsedThisRequest: 1 });
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).not.toContain('countdownapi.com');
    }
  });

  it('refuses a token without browser:read with ACTION_BLOCKED before any vendor call', async () => {
    const before = vendorRequests.length;
    const response = await clientWith(await mintToken('dashboards:read')).callTool('ebay_api_search', { searchTerm: 'lego' });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).toBe(true);
    const error = errorOf(response);
    expect(error?.code).toBe('ACTION_BLOCKED');
    expect(error?.message).toContain('browser:read');
    expect(vendorRequests).toHaveLength(before);
  });

  it('refuses a schema-invalid call before any vendor call', async () => {
    const before = vendorRequests.length;
    const response = await clientWith(await mintToken('browser:read')).callTool('ebay_api_search', {
      searchTerm: 'lego',
      url: 'https://www.ebay.ca/sch/i.html?_nkw=lego',
    });
    expect(response.body.result?.isError).toBe(true);
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
