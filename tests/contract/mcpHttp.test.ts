/**
 * Contract layer (§27.1): modern 2026-07-28 request handling at the HTTP
 * surface — envelope enforcement, legacy rejection (§5/§9), header/body
 * agreement, error catalog stability, and RFC 9728 discovery (§10.1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_PROTOCOL_VERSION, BRIDGE_ERROR_CODES, TOOL_CATALOG } from '@browser-bridge/protocol';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { ModernMcpClient, MODERN_META } from '../helpers/mcpClient.js';

let harness: GatewayHarness;
let client: ModernMcpClient;

beforeAll(() => {
  harness = buildGatewayHarness();
  client = new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch);
});
afterAll(async () => {
  await harness.close();
});

describe('modern/stateless MCP profile (§9)', () => {
  it('serves tools/list with every catalogued tool and derived JSON schemas', async () => {
    const response = await client.listTools();
    expect(response.status).toBe(200);
    const tools = response.body.result?.tools ?? [];
    expect(tools).toHaveLength(TOOL_CATALOG.length);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('browser.extract');
    const screenshot = tools.find((tool) => tool.name === 'browser.screenshot');
    expect(screenshot?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('does not require initialize or Mcp-Session-Id (self-describing requests)', async () => {
    // A bare tools/list with the modern envelope succeeds with no prior
    // handshake and no session header (NFR-08).
    const response = await client.request('tools/list', {});
    expect(response.status).toBe(200);
    expect(response.body.result?.tools).toBeDefined();
  });

  it('rejects 2025-era requests when compatibility is disabled (§5, §9)', async () => {
    const noVersion = await client.request('tools/list', {}, { omitMeta: true, omitEnvelopeHeaders: true });
    expect(noVersion.status).toBe(400);
    expect(noVersion.body.error?.code).toBe(-32022);
    expect((noVersion.body.error?.data as { supported?: string[] })?.supported).toEqual([MCP_PROTOCOL_VERSION]);

    const initialize = await client.request(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      { omitMeta: true, omitEnvelopeHeaders: true },
    );
    expect(initialize.status).toBe(400);
    expect(initialize.body.error?.code).toBe(-32022);
  });

  it('rejects modern requests missing the _meta envelope', async () => {
    const response = await client.request('tools/list', {}, { omitMeta: true });
    expect(response.status).toBe(400);
    expect(response.body.error?.message).toMatch(/_meta/);
  });

  it('validates Mcp-Name header against the body (§9)', async () => {
    const response = await client.request(
      'tools/call',
      { name: 'browser.tabs', arguments: { browserSessionHandle: 'bs_0123456789abcdefgh' }, _meta: MODERN_META },
      { toolName: 'browser.snapshot', omitMeta: true },
    );
    expect(response.status).toBe(400);
    expect(response.body.error?.message).toMatch(/disagree|mismatch|Mcp-Name/i);
  });

  it('serves legacy statelessly when compatibility is explicitly enabled (§9)', async () => {
    const compat = buildGatewayHarness({ env: { MCP_LEGACY_COMPATIBILITY: 'true' } });
    try {
      const legacyClient = new ModernMcpClient('https://browser-mcp.test.example/mcp', compat.fetch);
      const response = await legacyClient.request(
        'tools/list',
        {},
        { omitMeta: true, omitEnvelopeHeaders: true, headers: { 'MCP-Protocol-Version': '2025-06-18' } },
      );
      expect(response.status).toBe(200);
      expect(response.body.result?.tools).toHaveLength(TOOL_CATALOG.length);
    } finally {
      await compat.close();
    }
  });
});

describe('tool-call error surface (FR-12, §17)', () => {
  it('returns catalogued machine-readable errors as tool results', async () => {
    const response = await client.callTool('browser.session_open', { deviceId: 'dev_not_connected' });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).toBe(true);
    const text = response.body.result?.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as { error: { code: string; retryable: boolean } };
    expect(parsed.error.code).toBe('DEVICE_OFFLINE');
    expect(parsed.error.retryable).toBe(true);
    expect(BRIDGE_ERROR_CODES).toContain(parsed.error.code);
  });

  it('rejects malformed tool arguments before any device dispatch', async () => {
    const response = await client.callTool('browser.navigate', {
      browserSessionHandle: 'bs_0123456789abcdefgh',
      tabId: 'tab_1',
      url: 'not-a-url',
    });
    // SDK-level input validation failure surfaces as an error result.
    const isError = response.body.result?.isError === true || response.body.error !== undefined;
    expect(isError).toBe(true);
  });

  it('SESSION_NOT_FOUND for unknown handles (§14 validation)', async () => {
    const response = await client.callTool('browser.tabs', { browserSessionHandle: 'bs_0123456789abcdefgh' });
    const text = response.body.result?.content?.[0]?.text ?? '{}';
    expect(JSON.parse(text).error.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('RFC 9728 discovery (§10.1)', () => {
  it('serves Protected Resource Metadata at the endpoint-specific path and root fallback', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const response = await harness.fetch(new Request(`https://browser-mcp.test.example${path}`));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { resource: string; scopes_supported: string[] };
      expect(body.resource).toBe('https://browser-mcp.test.example/mcp');
      expect(body.scopes_supported).toContain('browser:read');
    }
  });
});

describe('health endpoints (§26)', () => {
  it('healthz and readyz respond; device availability is not readiness', async () => {
    const health = await harness.fetch(new Request('https://browser-mcp.test.example/healthz'));
    expect(health.status).toBe(200);
    const ready = await harness.fetch(new Request('https://browser-mcp.test.example/readyz'));
    expect(ready.status).toBe(200);
  });
});
