/**
 * The dashboard roster is declared in three places that must agree: the id
 * list, the per-dashboard OAuth write scope, and the ingest token the gateway
 * reads for it. A dashboard added to one and not the others fails silently —
 * its tools are simply absent, or its scope never appears in the RFC 9728
 * metadata, and nothing throws.
 */
import { describe, expect, it } from 'vitest';
import { DASHBOARD_IDS, DASHBOARD_WRITE_SCOPES, ALL_DASHBOARD_SCOPES, requiredDashboardScope } from '@browser-bridge/protocol';
import { loadGatewayConfig } from '@browser-bridge/config';

describe('dashboard catalog is complete for every id', () => {
  it('every id has a write scope, and no scope is shared between two ids', () => {
    for (const id of DASHBOARD_IDS) {
      expect(DASHBOARD_WRITE_SCOPES[id], `${id} has no write scope`).toBe(`${id}:write`);
      expect(ALL_DASHBOARD_SCOPES).toContain(`${id}:write`);
      expect(requiredDashboardScope(id, 'upsert')).toBe(`${id}:write`);
    }
    const scopes = Object.values(DASHBOARD_WRITE_SCOPES);
    expect(new Set(scopes).size, 'a write scope is shared between dashboards').toBe(scopes.length);
  });

  it('every id has a <ID>_INGEST_TOKEN the config actually reads', () => {
    // Set one token per dashboard and prove each lands under its own key. A
    // schema entry that was added without the corresponding line in the token
    // map parses fine and then silently yields no token.
    const env: Record<string, string> = {
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'https://browser-mcp.test.example',
      DATABASE_URL: 'postgres://unused',
      DASHBOARD_API_BASE_URL: 'http://dashboard-api:8082',
    };
    for (const id of DASHBOARD_IDS) env[`${id.toUpperCase()}_INGEST_TOKEN`] = `tok-${id}`;

    const config = loadGatewayConfig(env);
    for (const id of DASHBOARD_IDS) {
      expect(config.dashboards?.tokens[id], `${id.toUpperCase()}_INGEST_TOKEN is not read into tokens.${id}`).toBe(`tok-${id}`);
    }
  });

  it('includes wardrobe', () => {
    // Named explicitly: the roster grew after the other four shipped, and the
    // generic assertions above would still pass if it were dropped again.
    expect(DASHBOARD_IDS).toContain('wardrobe');
  });
});
