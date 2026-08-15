/**
 * Rate limiting and body caps at the HTTP boundary (audit F-05, F-23).
 * Limits are configurable via env; RATE_LIMITED is the §17 catalogued
 * code; oversized JSON bodies fail with 413 before any dispatch.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

const cleanups: GatewayHarness[] = [];
afterAll(async () => {
  for (const harness of cleanups) await harness.close();
});

describe('/mcp per-client rate limit (F-05)', () => {
  it('serves up to the configured burst then answers 429 RATE_LIMITED with Retry-After', async () => {
    const harness = buildGatewayHarness({ env: { RATE_LIMIT_MCP_PER_MINUTE: '3' } });
    cleanups.push(harness);
    const client = new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch);
    for (let i = 0; i < 3; i++) {
      const ok = await client.listTools();
      expect(ok.status, `call ${i + 1}`).toBe(200);
    }
    const limitedResponse = await harness.fetch(
      new Request('https://browser-mcp.test.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
      }),
    );
    expect(limitedResponse.status).toBe(429);
    expect(Number(limitedResponse.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const body = (await limitedResponse.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryable).toBe(true);
  });

  it('a limit of 0 disables the bucket', async () => {
    const harness = buildGatewayHarness({ env: { RATE_LIMIT_MCP_PER_MINUTE: '0' } });
    cleanups.push(harness);
    const client = new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch);
    for (let i = 0; i < 10; i++) {
      expect((await client.listTools()).status).toBe(200);
    }
  });
});

describe('JSON body caps (F-23)', () => {
  it('rejects oversized /mcp bodies with 413 before dispatch', async () => {
    const harness = buildGatewayHarness();
    cleanups.push(harness);
    const hugeArgument = 'x'.repeat(200 * 1024);
    const response = await harness.fetch(
      new Request('https://browser-mcp.test.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'browser.tabs', arguments: { browserSessionHandle: hugeArgument } },
        }),
      }),
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('/agent/pair per-address rate limit (F-05)', () => {
  it('throttles repeated pairing attempts from one address', async () => {
    const harness = buildGatewayHarness({ env: { RATE_LIMIT_PAIR_PER_MINUTE: '2' } });
    cleanups.push(harness);
    const attempt = () =>
      harness.fetch(
        new Request('https://browser-mcp.test.example/agent/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify({
            pairingToken: 'not-a-real-token-aaaaaaaa',
            publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=\n-----END PUBLIC KEY-----',
            deviceName: 'probe',
            agentVersion: '0.1.0',
          }),
        }),
      );
    const first = await attempt();
    const second = await attempt();
    expect([400, 401]).toContain(first.status); // budget consumed, auth still fails
    expect([400, 401]).toContain(second.status);
    const third = await attempt();
    expect(third.status).toBe(429);
    // A different address has its own bucket.
    const other = await harness.fetch(
      new Request('https://browser-mcp.test.example/agent/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
        body: JSON.stringify({ pairingToken: 'x'.repeat(24), publicKeyPem: 'y'.repeat(64), deviceName: 'p', agentVersion: '1' }),
      }),
    );
    expect(other.status).not.toBe(429);
  });
});
