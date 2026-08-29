/**
 * Dashboard write-path end to end: OAuth-verified MCP call → gateway-served
 * dashboard.* tool → stubbed dashboard-api. No Windows device is on this
 * path, and the ingest token must appear only in the gateway's outbound
 * request — never in tool input or output.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtTokenVerifier } from '@browser-bridge/gateway';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

const ISSUER = 'https://idp.test.example/realms/fluxology';
const AUDIENCE = 'https://browser-mcp.test.example/mcp';

let privateKey: CryptoKey;
let harness: GatewayHarness;
const upstreamRequests: { url: string; method: string; authorization: string | undefined; body: unknown }[] = [];

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

const FEED_ROOT = {
  schemaVersion: 3,
  searchName: 'Fluxology curated shopping deals',
  listings: [{ id: 'kijiji-1111111', title: 'existing', lastSeen: '2026-08-17T00:00:00Z' }],
};

const stubDashboardApi: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
  upstreamRequests.push({
    url,
    method: init?.method ?? 'GET',
    authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
    body,
  });
  if (url.endsWith('/v1/deals/feed')) {
    return Response.json(FEED_ROOT);
  }
  if (url.endsWith('/v1/vacation/upsert')) {
    const listings = (body as { listings: unknown[] }).listings;
    return Response.json({ ok: true, scope: 'vacation', upserted: listings.length, unchanged: 0 });
  }
  if (url.endsWith('/v1/deals/upsert')) {
    const listings = (body as { listings: unknown[] }).listings;
    return Response.json({ ok: true, scope: 'deals', upserted: listings.length, unchanged: 0 });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
};

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
  harness = buildGatewayHarness({
    verifier,
    env: {
      DASHBOARD_API_BASE_URL: 'http://dashboard-api:8082',
      DEALS_INGEST_TOKEN: 'secret-deals-token',
      VACATION_INGEST_TOKEN: 'secret-vacation-token',
    },
    dashboardFetch: stubDashboardApi,
  });
});
afterAll(async () => {
  await harness?.close();
});

function clientWith(token: string): ModernMcpClient {
  return new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch, token);
}

describe('dashboard tools over the live MCP surface', () => {
  it('registers dashboard.feed and dashboard.upsert alongside the browser tools', async () => {
    const response = await clientWith(await mintToken('deals:write')).listTools();
    expect(response.status).toBe(200);
    const names = (response.body.result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain('dashboard.feed');
    expect(names).toContain('dashboard.upsert');
  });

  it('upserts with the gateway-held ingest token; the token never reaches the caller', async () => {
    const response = await clientWith(await mintToken('deals:write')).callTool('dashboard.upsert', {
      dashboard: 'deals',
      listings: [{ id: 'ebay-226123456789', title: 'LEGO minifig lot', priceCad: 42.5 }],
    });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).not.toBe(true);
    const structured = response.body.result?.structuredContent as { ok: boolean; result: { upserted: number } };
    expect(structured.ok).toBe(true);
    expect(structured.result.upserted).toBe(1);
    const upstream = upstreamRequests.find((request) => request.url.endsWith('/v1/deals/upsert'));
    expect(upstream?.authorization).toBe('Bearer secret-deals-token');
    expect(JSON.stringify(response.body)).not.toContain('secret-deals-token');
  });

  it('reads the feed with write scope (write implies read)', async () => {
    const response = await clientWith(await mintToken('deals:write')).callTool('dashboard.feed', {
      dashboard: 'deals',
      mode: 'ids',
    });
    expect(response.status).toBe(200);
    const structured = response.body.result?.structuredContent as {
      listingCount: number;
      root: { listings: unknown[] };
    };
    expect(structured.listingCount).toBe(1);
    expect(structured.root.listings).toEqual([{ id: 'kijiji-1111111', lastSeen: '2026-08-17T00:00:00Z' }]);
  });

  it('upserts to the vacation dashboard with vacation:write only', async () => {
    const response = await clientWith(await mintToken('vacation:write')).callTool('dashboard.upsert', {
      dashboard: 'vacation',
      listings: [{ id: 'vacation-someresort-oceansuite', title: 'Ocean Suite' }],
    });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).not.toBe(true);
    const structured = response.body.result?.structuredContent as { ok: boolean; result: { upserted: number } };
    expect(structured.ok).toBe(true);
    expect(structured.result.upserted).toBe(1);
    const upstream = upstreamRequests.find((r) => r.url.endsWith('/v1/vacation/upsert'));
    expect(upstream?.authorization).toBe('Bearer secret-vacation-token');
    expect(JSON.stringify(response.body)).not.toContain('secret-vacation-token');
  });

  it('touch-only upserts reach the upstream as {id,lastSeen} records', async () => {
    const response = await clientWith(await mintToken('deals:write')).callTool('dashboard.upsert', {
      dashboard: 'deals',
      touch: [{ id: 'kijiji-1111111', lastSeen: '2026-08-29T12:00:00Z' }],
    });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).not.toBe(true);
    const structured = response.body.result?.structuredContent as {
      ok: boolean;
      summary: { sent: number; touched: number; upserted: number };
    };
    expect(structured.ok).toBe(true);
    expect(structured.summary.touched).toBe(1);
    expect(structured.summary.upserted).toBe(1);
    const upstream = upstreamRequests.filter((request) => request.url.endsWith('/v1/deals/upsert')).at(-1);
    expect(upstream?.body).toEqual({ listings: [{ id: 'kijiji-1111111', lastSeen: '2026-08-29T12:00:00Z' }] });
  });

  it('an upsert that names neither listings nor touch is refused at the schema', async () => {
    const response = await clientWith(await mintToken('deals:write')).callTool('dashboard.upsert', {
      dashboard: 'deals',
    });
    expect(response.body.result?.isError).toBe(true);
  });

  it('feed filter and fields shrink what the caller has to read', async () => {
    const response = await clientWith(await mintToken('deals:write')).callTool('dashboard.feed', {
      dashboard: 'deals',
      filter: { marketplace: 'kijiji' },
      fields: ['lastSeen'],
    });
    expect(response.status).toBe(200);
    const structured = response.body.result?.structuredContent as {
      listingCount: number;
      totalListingCount: number;
      root: { listings: unknown[] };
    };
    expect(structured.listingCount).toBe(1);
    expect(structured.totalListingCount).toBe(1);
    expect(structured.root.listings).toEqual([{ id: 'kijiji-1111111', lastSeen: '2026-08-17T00:00:00Z' }]);
  });

  it('a filter that matches nothing says so instead of returning the whole feed', async () => {
    const response = await clientWith(await mintToken('deals:write')).callTool('dashboard.feed', {
      dashboard: 'deals',
      filter: { marketplace: 'ebay' },
    });
    const structured = response.body.result?.structuredContent as {
      listingCount: number;
      totalListingCount: number;
    };
    expect(structured.listingCount).toBe(0);
    expect(structured.totalListingCount).toBe(1);
  });

  it('a vacation:write token cannot write the deals dashboard', async () => {
    const response = await clientWith(await mintToken('vacation:write')).callTool('dashboard.upsert', {
      dashboard: 'deals',
      listings: [{ id: 'ebay-1' }],
    });
    const parsed = JSON.parse(response.body.result?.content?.[0]?.text ?? '{}') as { error?: { code: string; message: string } };
    expect(response.body.result?.isError).toBe(true);
    expect(parsed.error?.code).toBe('ACTION_BLOCKED');
    expect(parsed.error?.message).toContain('deals:write');
  });

  it('refuses an upsert from a browser-scopes-only token', async () => {
    const response = await clientWith(await mintToken('browser:read browser:interact')).callTool(
      'dashboard.upsert',
      { dashboard: 'deals', listings: [{ id: 'x' }] },
    );
    const text = response.body.result?.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as { error?: { code: string; message: string } };
    expect(response.body.result?.isError).toBe(true);
    expect(parsed.error?.code).toBe('ACTION_BLOCKED');
    expect(parsed.error?.message).toContain('deals:write');
  });

  it('refuses an upsert to a dashboard whose token the gateway does not hold', async () => {
    const response = await clientWith(await mintToken('jobs:write')).callTool('dashboard.upsert', {
      dashboard: 'jobs',
      listings: [{ id: 'job-1' }],
    });
    const text = response.body.result?.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as { error?: { code: string; message: string } };
    expect(response.body.result?.isError).toBe(true);
    expect(parsed.error?.code).toBe('ACTION_BLOCKED');
    expect(parsed.error?.message).toContain('JOBS_INGEST_TOKEN');
  });
});
