import { describe, expect, it } from 'vitest';
import { BridgeError, dashboardScopeSatisfies, requiredDashboardScope } from '@browser-bridge/protocol';
import { DashboardClient } from '@browser-bridge/gateway';
import { loadGatewayConfig } from '@browser-bridge/config';

const BASE_ENV = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'https://browser-mcp.test.example',
  DATABASE_URL: 'postgres://unused',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clientWith(fetchImpl: typeof fetch, tokens: Record<string, string> = { deals: 'tok-deals' }): DashboardClient {
  return new DashboardClient({ baseUrl: 'http://dashboard-api:8082/', tokens, fetchImpl });
}

describe('DashboardClient', () => {
  it('feed full mode returns the root untouched with a listing count', async () => {
    const root = { schemaVersion: 3, listings: [{ id: 'a', title: 'x', price: 5 }, { id: 'b' }] };
    const client = clientWith(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://dashboard-api:8082/v1/deals/feed');
      expect(init?.method).toBe('GET');
      // Feed reads are public server-side; no ingest token must leak into them.
      expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
      return jsonResponse(200, root);
    });
    const result = await client.feed('deals', 'full');
    expect(result.listingCount).toBe(2);
    expect(result.root).toEqual(root);
  });

  it('feed ids mode strips listings to identity/freshness fields', async () => {
    const root = {
      schemaVersion: 3,
      listings: [{ id: 'a', title: 'big', description: 'long', lastSeen: 't1', lastChanged: 't2', status: 'active' }],
    };
    const client = clientWith(async () => jsonResponse(200, root));
    const result = await client.feed('deals', 'ids');
    expect(result.root.listings).toEqual([{ id: 'a', lastSeen: 't1', lastChanged: 't2', status: 'active' }]);
    // Root metadata outside listings survives.
    expect((result.root as { schemaVersion: number }).schemaVersion).toBe(3);
  });

  it('upsert posts the bearer token and listing payload', async () => {
    const client = clientWith(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://dashboard-api:8082/v1/deals/upsert');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-deals');
      expect(JSON.parse(String(init?.body))).toEqual({ listings: [{ id: 'ebay-1' }] });
      return jsonResponse(200, { ok: true, scope: 'deals', upserted: 1 });
    });
    const result = await client.upsert('deals', [{ id: 'ebay-1' }]);
    expect(result.ok).toBe(true);
    expect(result.result.upserted).toBe(1);
  });

  it('upsert without a configured token for that dashboard refuses locally', async () => {
    const client = clientWith(async () => {
      throw new Error('must not reach the network');
    });
    await expect(client.upsert('jobs', [{ id: 'x' }])).rejects.toMatchObject({
      code: 'ACTION_BLOCKED',
    });
  });

  it('maps upstream statuses onto the stable error model', async () => {
    const byStatus = async (status: number): Promise<BridgeError> => {
      const client = clientWith(async () => jsonResponse(status, { error: 'nope' }));
      try {
        await client.upsert('deals', [{ id: 'x' }]);
        throw new Error('expected failure');
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        return err as BridgeError;
      }
    };
    expect((await byStatus(401)).code).toBe('ACTION_BLOCKED');
    expect((await byStatus(400)).code).toBe('ACTION_BLOCKED');
    expect((await byStatus(429)).code).toBe('RATE_LIMITED');
    const conflict = await byStatus(409);
    expect(conflict.code).toBe('INTERNAL_ERROR');
    expect(conflict.retryable).toBe(true);
    expect((await byStatus(503)).code).toBe('INTERNAL_ERROR');
  });

  it('network failure is a retryable INTERNAL_ERROR, not an unhandled throw', async () => {
    const client = clientWith(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client.feed('deals', 'full')).rejects.toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
  });
});

describe('dashboard scope rules', () => {
  it('upsert requires that dashboard write scope exactly', () => {
    expect(dashboardScopeSatisfies(['deals:write'], 'deals', 'upsert')).toBe(true);
    expect(dashboardScopeSatisfies(['deals:write'], 'jobs', 'upsert')).toBe(false);
    expect(dashboardScopeSatisfies(['dashboards:read'], 'deals', 'upsert')).toBe(false);
    expect(dashboardScopeSatisfies(['browser:interact'], 'deals', 'upsert')).toBe(false);
  });

  it('feed accepts dashboards:read or any write scope (write implies read)', () => {
    expect(dashboardScopeSatisfies(['dashboards:read'], 'office', 'feed')).toBe(true);
    expect(dashboardScopeSatisfies(['jobs:write'], 'office', 'feed')).toBe(true);
    expect(dashboardScopeSatisfies(['browser:read'], 'office', 'feed')).toBe(false);
  });

  it('names the required scope for error messages', () => {
    expect(requiredDashboardScope('deals', 'upsert')).toBe('deals:write');
    expect(requiredDashboardScope('deals', 'feed')).toBe('dashboards:read');
  });
});

describe('gateway dashboard configuration', () => {
  it('is null when DASHBOARD_API_BASE_URL is unset', () => {
    expect(loadGatewayConfig(BASE_ENV).dashboards).toBeNull();
  });

  it('collects the base URL and only the configured tokens', () => {
    const config = loadGatewayConfig({
      ...BASE_ENV,
      DASHBOARD_API_BASE_URL: 'http://dashboard-api:8082/',
      DEALS_INGEST_TOKEN: 'a',
      JOBS_INGEST_TOKEN: 'b',
    });
    expect(config.dashboards).toEqual({
      baseUrl: 'http://dashboard-api:8082',
      tokens: { deals: 'a', jobs: 'b' },
    });
  });

  it('rejects a token configured without a base URL', () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, DEALS_INGEST_TOKEN: 'a' })).toThrow(/DASHBOARD_API_BASE_URL/);
  });
});
