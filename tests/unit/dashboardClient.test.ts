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

  // 2026-09-05 (dashboard-feed-has-no-projection-paging-so-narrow-reads-are-
  // impossible): the compact read path passes the API's own query surface
  // through and returns its counts and cursor untouched.
  it('records builds the /records query from the options and returns the page with its counts', async () => {
    const page = { state: 'live', total: 585, matched: 158, returned: 40, archivedCount: 120, nextCursor: 40, listings: [{ id: 'ebay-1', title: 'x' }] };
    const client = clientWith(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1/deals/records');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        state: 'live',
        fields: 'id,title,active',
        since: '2026-09-04T00:00:00Z',
        recordType: 'candidate',
        sort: 'discovered',
        dir: 'asc',
        limit: '40',
        cursor: '0',
      });
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
      return jsonResponse(200, page);
    });
    const result = await client.records('deals', {
      state: 'live',
      fields: ['id', 'title', 'active'],
      since: '2026-09-04T00:00:00Z',
      recordType: 'candidate',
      sort: 'discovered',
      dir: 'asc',
      limit: 40,
      cursor: 0,
    });
    expect(result.dashboard).toBe('deals');
    expect(result.listings).toEqual([{ id: 'ebay-1', title: 'x' }]);
    expect(result.nextCursor).toBe(40);
    expect(result.matched).toBe(158);
  });

  it('records with no options asks for the first page with the API defaults', async () => {
    const client = clientWith(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://dashboard-api:8082/v1/deals/records');
      return jsonResponse(200, { total: 0, matched: 0, returned: 0, nextCursor: null, listings: [] });
    });
    const result = await client.records('deals');
    expect(result.listings).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('summary reads counts only and forwards archiveAfterDays', async () => {
    const client = clientWith(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://dashboard-api:8082/v1/wardrobe/summary?archiveAfterDays=30');
      return jsonResponse(200, { total: 12, live: 9, archived: 3, byRecordType: { offer: 12 }, byStatus: {} });
    });
    const result = await client.summary('wardrobe', { archiveAfterDays: 30 });
    expect(result.dashboard).toBe('wardrobe');
    expect(result.total).toBe(12);
    expect('listings' in result).toBe(false);
  });

  it('feed ids mode strips listings to identity/freshness fields', async () => {
    const root = {
      schemaVersion: 3,
      listings: [
        { id: 'a', title: 'big', description: 'long', lastSeen: 't1', lastChanged: 't2', status: 'tracked', active: false },
      ],
    };
    const client = clientWith(async () => jsonResponse(200, root));
    const result = await client.feed('deals', 'ids');
    // `active` rides along: an ids-mode diff must be able to tell a live
    // record from a retired one without re-fetching the full feed.
    expect(result.root.listings).toEqual([{ id: 'a', lastSeen: 't1', lastChanged: 't2', status: 'tracked', active: false }]);
    // Root metadata outside listings survives.
    expect((result.root as { schemaVersion: number }).schemaVersion).toBe(3);
  });

  it('feed filters by status, active and marketplace after fetching', async () => {
    // Mirrors the real feed shape: `active` is the boards' boolean retirement
    // flag, `status` a separate lifecycle vocabulary that never contains the
    // word "active" in practice (tracked, watching, needs_revalidation, …).
    const root = {
      schemaVersion: 3,
      listings: [
        { id: 'ebay-1', status: 'tracked', active: true, title: 'a' },
        { id: 'ebay-2', status: 'ended', active: false, title: 'b' },
        { id: 'kijiji-3', status: 'watching', active: true, title: 'c' },
        { id: 'kijiji-4', title: 'no status, no active flag' },
        { id: 'ebay-5', status: 'tracked', active: true, marketplace: 'kijiji', title: 'e' },
      ],
    };
    const client = clientWith(async () => jsonResponse(200, root));

    // A record counts as active unless explicitly retired with active:false,
    // so the flag-less kijiji-4 is active; its status has no say in it.
    const active = await client.feed('deals', 'full', { filter: { active: true } });
    expect(active.listingCount).toBe(4);
    expect(active.totalListingCount).toBe(5);
    expect((active.root.listings as { id: string }[]).map((l) => l.id)).toEqual([
      'ebay-1',
      'kijiji-3',
      'kijiji-4',
      'ebay-5',
    ]);

    const retired = await client.feed('deals', 'full', { filter: { active: false } });
    expect((retired.root.listings as { id: string }[]).map((l) => l.id)).toEqual(['ebay-2']);

    const ended = await client.feed('deals', 'full', { filter: { status: ['ENDED'] } });
    expect((ended.root.listings as { id: string }[]).map((l) => l.id)).toEqual(['ebay-2']);

    // Marketplace falls back to the stable-id prefix, and a record's own
    // marketplace field wins over its id when it has one.
    const kijiji = await client.feed('deals', 'full', { filter: { marketplace: 'kijiji' } });
    expect((kijiji.root.listings as { id: string }[]).map((l) => l.id)).toEqual(['kijiji-3', 'kijiji-4', 'ebay-5']);
  });

  it('feed fields projects listings and always keeps the id', async () => {
    const root = {
      schemaVersion: 3,
      listings: [{ id: 'ebay-1', title: 'a', priceCad: 5, description: 'long', status: 'active' }],
    };
    const client = clientWith(async () => jsonResponse(200, root));
    const projected = await client.feed('deals', 'full', { fields: ['priceCad'] });
    expect(projected.root.listings).toEqual([{ id: 'ebay-1', priceCad: 5 }]);
  });

  it('feed with neither filter nor fields is byte-for-byte the pre-Phase-2 response', async () => {
    const root = { schemaVersion: 3, listings: [{ id: 'a', title: 'x' }] };
    const client = clientWith(async () => jsonResponse(200, root));
    const result = await client.feed('deals', 'full');
    expect(result.root).toEqual(root);
    expect(result.listingCount).toBe(1);
    expect(result.totalListingCount).toBe(1);
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

  it('touch entries ride the same upsert as two-field records', async () => {
    let sent: unknown;
    const client = clientWith(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return jsonResponse(200, { ok: true, scope: 'deals', upserted: 1, unchanged: 2 });
    });
    const result = await client.upsert(
      'deals',
      [{ id: 'ebay-1', title: 'new find' }],
      [
        { id: 'kijiji-2', lastSeen: '2026-08-29T12:00:00Z' },
        // Same id as the full listing: the full record carries its own
        // lastSeen and must not be overwritten by a two-field touch.
        { id: 'ebay-1', lastSeen: '2026-08-29T12:00:00Z' },
      ],
    );
    expect(sent).toEqual({
      listings: [{ id: 'ebay-1', title: 'new find' }, { id: 'kijiji-2', lastSeen: '2026-08-29T12:00:00Z' }],
    });
    expect(result.summary).toEqual({ sent: 2, touched: 1, upserted: 1, unchanged: 2 });
  });

  it('a touch-only upsert is a valid write', async () => {
    let sent: unknown;
    const client = clientWith(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return jsonResponse(200, { ok: true, upserted: 0, unchanged: 1 });
    });
    const result = await client.upsert('deals', [], [{ id: 'ebay-1', lastSeen: '2026-08-29T12:00:00Z' }]);
    expect(sent).toEqual({ listings: [{ id: 'ebay-1', lastSeen: '2026-08-29T12:00:00Z' }] });
    expect(result.ok).toBe(true);
    expect(result.summary.touched).toBe(1);
  });

  it('the diff summary carries only the counts the upstream actually sent', async () => {
    const client = clientWith(async () => jsonResponse(200, { ok: true, scope: 'deals', upserted: 3 }));
    const result = await client.upsert('deals', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    // "unchanged" is absent, not zero: the API did not say.
    expect(result.summary).toEqual({ sent: 3, touched: 0, upserted: 3 });
    expect(result.result.scope).toBe('deals');
  });

  it('an upsert with nothing to say never reaches the network', async () => {
    const client = clientWith(async () => {
      throw new Error('must not reach the network');
    });
    await expect(client.upsert('deals', [], [])).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
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
    expect(dashboardScopeSatisfies(['vacation:write'], 'vacation', 'upsert')).toBe(true);
    expect(dashboardScopeSatisfies(['jobs:write'], 'vacation', 'upsert')).toBe(false);
    expect(dashboardScopeSatisfies(['vacation:write'], 'deals', 'upsert')).toBe(false);
    expect(dashboardScopeSatisfies(['browser:interact'], 'deals', 'upsert')).toBe(false);
  });

  it('feed accepts dashboards:read or any write scope (write implies read)', () => {
    expect(dashboardScopeSatisfies(['dashboards:read'], 'office', 'feed')).toBe(true);
    expect(dashboardScopeSatisfies(['jobs:write'], 'office', 'feed')).toBe(true);
    expect(dashboardScopeSatisfies(['vacation:write'], 'office', 'feed')).toBe(true);
    expect(dashboardScopeSatisfies(['dashboards:read'], 'vacation', 'feed')).toBe(true);
    expect(dashboardScopeSatisfies(['browser:read'], 'office', 'feed')).toBe(false);
  });

  it('names the required scope for error messages', () => {
    expect(requiredDashboardScope('deals', 'upsert')).toBe('deals:write');
    expect(requiredDashboardScope('deals', 'feed')).toBe('dashboards:read');
    expect(requiredDashboardScope('vacation', 'upsert')).toBe('vacation:write');
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
      VACATION_INGEST_TOKEN: 'c',
    });
    expect(config.dashboards).toEqual({
      baseUrl: 'http://dashboard-api:8082',
      tokens: { deals: 'a', jobs: 'b', vacation: 'c' },
    });
  });

  it('rejects a token configured without a base URL', () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, DEALS_INGEST_TOKEN: 'a' })).toThrow(/DASHBOARD_API_BASE_URL/);
    expect(() => loadGatewayConfig({ ...BASE_ENV, VACATION_INGEST_TOKEN: 'a' })).toThrow(/DASHBOARD_API_BASE_URL/);
  });
});
