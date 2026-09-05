/**
 * Security invariants (§27.2): no navigation to localhost, RFC1918,
 * link-local, file:, data:, or javascript: targets; redirect/rebinding
 * revalidation; the production eBay profile carries no test escapes; and
 * the Countdown source tools hand the vendor nothing off the two eBay
 * marketplaces (docs/COUNTDOWN-API-PLAN.md §2 URL policy, Security).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CountdownConfig } from '@browser-bridge/config';
import { CountdownSource, MemoryStore } from '@browser-bridge/gateway';
import { checkUrl } from '@browser-bridge/policy';
import { EbayApiItemsInput, EbayApiSearchInput } from '@browser-bridge/protocol';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

const publicResolve = async () => ['23.55.0.10'];

describe('production profile hygiene', () => {
  it('ebay.ca.v1 carries the normative allowlist and no test escapes', () => {
    expect(ebaySiteProfile.id).toBe('ebay.ca.v1');
    expect(ebaySiteProfile.testOnly).toBeUndefined();
    expect([...ebaySiteProfile.allowedHosts].sort()).toEqual(
      [
        '*.ebay.ca',
        '*.ebay.com',
        '*.ebaydesc.com',
        '*.ebayimg.com',
        '*.ebaystatic.com',
        'ebay.ca',
        'ebay.com',
        'ebaydesc.com',
        'ebayimg.com',
        'ebaystatic.com',
      ].sort(),
    );
    expect(ebaySiteProfile.destinationPostalCode).toBe('M6H 2W9');
  });
});

describe('scheme denial (§19.1)', () => {
  const deniedSchemes = [
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'blob:https://www.ebay.ca/uuid',
    'chrome://settings',
    'chrome-extension://abcdef/page.html',
    'about:config',
    'view-source:https://www.ebay.ca/',
    'ftp://ebay.ca/file',
    'http://www.ebay.ca/itm/1',
  ];
  it.each(deniedSchemes)('denies %s', async (url) => {
    const decision = await checkUrl(url, ebaySiteProfile, 'navigation', { resolve: publicResolve });
    expect(decision.allowed).toBe(false);
    expect(decision.errorCode).toBe('SCHEME_DENIED');
  });
});

describe('private/local network denial (§19.1, §27.2)', () => {
  const literalTargets = [
    'https://127.0.0.1/admin',
    'https://localhost/admin',
    'https://[::1]/admin',
    'https://10.0.0.5/',
    'https://192.168.1.10/router',
    'https://172.16.0.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://0.0.0.0/',
    'https://[fe80::1]/',
    'https://[fc00::1]/',
    'https://[::ffff:127.0.0.1]/',
  ];
  it.each(literalTargets)('denies %s', async (url) => {
    const decision = await checkUrl(url, ebaySiteProfile, 'navigation', { resolve: publicResolve });
    expect(decision.allowed).toBe(false);
    // Off-allowlist hosts fail closed on ORIGIN_DENIED before address checks;
    // both codes satisfy the invariant that navigation never proceeds.
    expect(['ORIGIN_DENIED', 'PRIVATE_NETWORK_DENIED']).toContain(decision.errorCode);
  });

  it('denies allowlisted hosts that RESOLVE to prohibited ranges (DNS rebinding)', async () => {
    for (const addresses of [['127.0.0.1'], ['10.1.2.3'], ['169.254.169.254'], ['::1'], ['104.18.0.1', '192.168.0.9']]) {
      const decision = await checkUrl('https://www.ebay.ca/itm/1', ebaySiteProfile, 'redirect', {
        resolve: async () => addresses,
      });
      expect(decision.allowed, addresses.join(',')).toBe(false);
      expect(decision.errorCode).toBe('PRIVATE_NETWORK_DENIED');
    }
  });

  it('revalidates every hop context, not just first navigation', async () => {
    for (const context of ['navigation', 'redirect', 'popup', 'frame', 'image_download'] as const) {
      const decision = await checkUrl('https://internal.attacker.example/', ebaySiteProfile, context, {
        resolve: publicResolve,
      });
      expect(decision.allowed, context).toBe(false);
    }
  });

  it('decimal/hex IP obfuscation cannot bypass the allowlist', async () => {
    for (const url of ['https://2130706433/', 'https://0x7f000001/', 'https://017700000001/']) {
      const decision = await checkUrl(url, ebaySiteProfile, 'navigation', { resolve: publicResolve });
      expect(decision.allowed, url).toBe(false);
    }
  });
});

describe('Countdown source tools never hand the vendor an off-policy URL (plan §2)', () => {
  const searchUrls = [
    ['a non-eBay host', 'https://evil.example/sch/i.html?_nkw=lego'],
    ['a lookalike host', 'https://www.ebay.ca.evil.example/sch/i.html?_nkw=lego'],
    ['a private-network host', 'https://10.0.0.5/sch/i.html?_nkw=lego'],
    ['loopback', 'https://127.0.0.1/sch/i.html?_nkw=lego'],
    ['the cloud metadata address', 'https://169.254.169.254/sch/latest/meta-data'],
    ['plain http on the real host', 'http://www.ebay.ca/sch/i.html?_nkw=lego'],
  ] as const;
  const itemUrls = [
    ['a non-eBay item url', 'https://attacker.example/itm/123456789012'],
    ['a private-network item url', 'https://192.168.1.10/itm/123456789012'],
    ['an http item url', 'http://www.ebay.ca/itm/123456789012'],
  ] as const;

  let vendorCalls = 0;
  const countingVendor: typeof fetch = (async () => {
    vendorCalls += 1;
    return new Response(JSON.stringify({ request_info: { success: false, message: 'must never be reached' } }), { status: 400 });
  }) as typeof fetch;

  // OAuth disabled: the development identity carries browser:read, so the
  // only thing between the caller and the vendor is the URL policy.
  let harness: GatewayHarness;
  let client: ModernMcpClient;
  beforeAll(() => {
    harness = buildGatewayHarness({ countdownApiKey: 'cd-ssrf-test-key', countdownFetch: countingVendor });
    client = new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch);
  });
  afterAll(async () => {
    await harness.close();
  });

  it.each(searchUrls)('ebay_api_search refuses %s before any outbound call', async (_label, url) => {
    const response = await client.callTool('ebay_api_search', { url });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).toBe(true);
    expect(vendorCalls).toBe(0);
  });

  it.each(itemUrls)('ebay_api_items refuses %s before any outbound call', async (_label, url) => {
    const response = await client.callTool('ebay_api_items', { items: [{ itemId: '123456789012' }, { url }] });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).toBe(true);
    expect(vendorCalls).toBe(0);
  });

  it('ebay_api_seller refuses an off-policy profile url before any outbound call', async () => {
    for (const url of ['https://evil.example/usr/tweedsidesales', 'http://www.ebay.ca/usr/tweedsidesales', 'https://www.ebay.ca/itm/123456789012']) {
      const response = await client.callTool('ebay_api_seller', { url });
      expect(response.body.result?.isError, url).toBe(true);
    }
    expect(vendorCalls).toBe(0);
  });

  it('the source itself screens a url again, so a caller that bypasses the schema is still ORIGIN_DENIED', async () => {
    let directCalls = 0;
    const config: CountdownConfig = {
      apiKey: 'cd-ssrf-direct-key',
      role: 'primary',
      baseUrl: 'https://api.countdownapi.com',
      creditReserve: { kind: 'absolute', credits: 0, configured: '0' },
      maxConcurrency: 2,
      timeoutMs: 5_000,
      destinations: {
        toronto: { customerLocation: 'ca', customerZipcode: 'M6H2W9' },
        forwarder: { customerLocation: 'us', customerZipcode: '34249' },
      },
    };
    const source = new CountdownSource({
      config,
      store: new MemoryStore(),
      fetchImpl: (async () => {
        directCalls += 1;
        return new Response('{}', { status: 400 });
      }) as typeof fetch,
    });
    const searchDefaults = EbayApiSearchInput.parse({ searchTerm: 'lego' });
    for (const [, url] of searchUrls) {
      await expect(source.search({ ...searchDefaults, searchTerm: undefined, url })).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    }
    const itemDefaults = EbayApiItemsInput.parse({ items: [{ itemId: '123456789012' }] });
    for (const [, url] of itemUrls) {
      await expect(source.items({ ...itemDefaults, items: [{ itemId: '123456789012' }, { url }] })).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    }
    expect(directCalls).toBe(0);
  });
});

describe('Countdown source tools forward the parsed URL, never the raw string (plan §2)', () => {
  // WHATWG reads "\" as "/": an eBay path to the screen, host evil.com to an
  // RFC 3986 parser such as the vendor's.
  const BACKSLASH_SEARCH = 'https://www.ebay.ca\\sch\\i.html@evil.com/?_nkw=lego';
  const BACKSLASH_ITEM = 'https://www.ebay.ca\\itm\\123456789012@evil.com/';
  const BACKSLASH_SELLER = 'https://www.ebay.ca\\usr\\tweedsidesales@evil.com/';

  const forwarded: string[] = [];
  const recordingVendor: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    // The reserve gate reads the free account endpoint before the first
    // charged request; it forwards no URL and is not what this test records.
    if (url.pathname === '/account') {
      const body = { request_info: { success: true }, account_info: { plan: 'starter', credits_used: 10, credits_limit: 10_000, credits_remaining: 9_990 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    forwarded.push(url.searchParams.get('url') ?? '(none)');
    const type = url.searchParams.get('type');
    const body =
      type === 'search'
        ? { request_info: { success: true }, search_results: [], pagination: { current_page: 1, total_results: 0, has_next_page: false } }
        : type === 'product'
          ? { request_info: { success: true }, message: 'Product not found.' }
          : { request_info: { success: true }, message: 'Seller not found.' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  let harness: GatewayHarness;
  let client: ModernMcpClient;
  beforeAll(() => {
    harness = buildGatewayHarness({ countdownApiKey: 'cd-ssrf-forward-key', countdownFetch: recordingVendor });
    client = new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch);
  });
  afterAll(async () => {
    await harness.close();
  });

  it("hands the vendor the WHATWG-normalised href of an accepted URL, not the caller's spelling of it", async () => {
    // An upper-case host and a default port are accepted, and forwarded as the parser read them.
    const search = await client.callTool('ebay_api_search', { url: 'https://WWW.EBAY.CA:443/sch/i.html?_nkw=lego&LH_Auction=1' });
    expect(search.body.result?.isError).not.toBe(true);
    expect(forwarded).toEqual(['https://www.ebay.ca/sch/i.html?_nkw=lego&LH_Auction=1']);

    const items = await client.callTool('ebay_api_items', { items: [{ url: 'https://WWW.EBAY.CA/itm/123456789012' }] });
    expect(items.body.result?.isError).not.toBe(true);
    expect(forwarded.at(-1)).toBe('https://www.ebay.ca/itm/123456789012');

    const seller = await client.callTool('ebay_api_seller', { url: 'https://WWW.EBAY.CA:443/usr/tweedsidesales' });
    expect(seller.body.result?.isError).not.toBe(true);
    expect(forwarded.at(-1)).toBe('https://www.ebay.ca/usr/tweedsidesales');
    expect(forwarded).toHaveLength(3);
  });

  it('a backslash-smuggled host reaches neither the vendor nor a WHATWG repair', async () => {
    const before = forwarded.length;
    const calls: Array<[string, Record<string, unknown>]> = [
      ['ebay_api_search', { url: BACKSLASH_SEARCH }],
      ['ebay_api_items', { items: [{ url: BACKSLASH_ITEM }] }],
      ['ebay_api_seller', { url: BACKSLASH_SELLER }],
    ];
    for (const [tool, args] of calls) {
      const response = await client.callTool(tool, args);
      expect(response.status, tool).toBe(200);
      expect(response.body.result?.isError, tool).toBe(true);
    }
    expect(forwarded).toHaveLength(before);

    // Below the schema the source refuses the same strings itself, naming the reason.
    const source = new CountdownSource({ config: harness.config.countdown!, store: new MemoryStore(), fetchImpl: recordingVendor });
    const itemDefaults = EbayApiItemsInput.parse({ items: [{ itemId: '123456789012' }] });
    await expect(source.items({ ...itemDefaults, items: [{ url: BACKSLASH_ITEM }] })).rejects.toMatchObject({
      code: 'ORIGIN_DENIED',
      message: expect.stringMatching(/backslash/),
    });
    const searchDefaults = EbayApiSearchInput.parse({ searchTerm: 'lego' });
    await expect(source.search({ ...searchDefaults, searchTerm: undefined, url: BACKSLASH_SEARCH })).rejects.toMatchObject({
      code: 'ORIGIN_DENIED',
      message: expect.stringMatching(/backslash/),
    });
    await expect(source.seller({ domain: 'ebay.ca', url: BACKSLASH_SELLER })).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    expect(forwarded).toHaveLength(before);
  });
});
