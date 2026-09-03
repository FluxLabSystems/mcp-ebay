/**
 * Contract layer (§27.1): modern 2026-07-28 request handling at the HTTP
 * surface — envelope enforcement, legacy rejection (§5/§9), header/body
 * agreement, error catalog stability, and RFC 9728 discovery (§10.1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_PROTOCOL_VERSION, BRIDGE_ERROR_CODES, ERROR_CATALOG, TOOL_CATALOG } from '@browser-bridge/protocol';
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
    expect(names).toContain('browser_extract');
    const screenshot = tools.find((tool) => tool.name === 'browser_screenshot');
    expect(screenshot?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('serves tool names free of characters the host permission layer rewrites', async () => {
    // 2026-09-01 root cause of the routine approval spam: claude.ai carries
    // per-tool Always-allow policies VERBATIM under the served name, while
    // the Claude Code CLI normalizes non [a-zA-Z0-9_-] characters to "_"
    // before matching. A dot in a served name therefore makes every allow
    // rule and stored policy for that tool permanently unmatchable.
    const response = await client.listTools();
    for (const tool of response.body.result?.tools ?? []) {
      expect(tool.name, `tool name ${tool.name} would be rewritten by host normalization`).toMatch(
        /^[a-zA-Z0-9_-]+$/,
      );
    }
  });

  it('serves annotations on the tools/list payload (not just in the catalog)', async () => {
    // No test asserted this before 2026-09-01; a regression dropping the
    // annotations key would have shipped invisibly.
    const response = await client.listTools();
    const tools = response.body.result?.tools ?? [];
    const byName = new Map(tools.map((tool) => [tool.name, tool as { annotations?: Record<string, unknown> }]));
    expect(byName.get('browser_extract')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get('browser_navigate')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
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
      { name: 'browser_tabs', arguments: { browserSessionHandle: 'bs_0123456789abcdefgh' }, _meta: MODERN_META },
      { toolName: 'browser_snapshot', omitMeta: true },
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
    const response = await client.callTool('browser_session_open', { deviceId: 'dev_not_connected' });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).toBe(true);
    const text = response.body.result?.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as {
      error: { code: string; message: string; retryable: boolean; details: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe('DEVICE_OFFLINE');
    expect(parsed.error.retryable).toBe(true);
    expect(BRIDGE_ERROR_CODES).toContain(parsed.error.code);
    // DEVICE_OFFLINE says what the gateway knows (2026-09-03 deals-routine
    // report): the id as requested, what it resolved to, who is online and
    // who is paired — nothing here, so the lists are empty but present —
    // and a hint that is also appended to the catalog message.
    expect(parsed.error.details).toEqual({
      deviceId: 'dev_not_connected',
      resolvedDeviceId: 'dev_not_connected',
      onlineDeviceIds: [],
      knownDevices: [],
      hint: 'No Windows agent is connected and no device has been paired; pair one with device:pair on the gateway.',
    });
    expect(parsed.error.message).toBe(`${ERROR_CATALOG.DEVICE_OFFLINE.message} ${parsed.error.details.hint}`);
  });

  it('rejects malformed tool arguments before any device dispatch', async () => {
    const response = await client.callTool('browser_navigate', {
      browserSessionHandle: 'bs_0123456789abcdefgh',
      tabId: 'tab_1',
      url: 'not-a-url',
    });
    // SDK-level input validation failure surfaces as an error result.
    const isError = response.body.result?.isError === true || response.body.error !== undefined;
    expect(isError).toBe(true);
  });

  it('SESSION_NOT_FOUND for unknown handles (§14 validation)', async () => {
    const response = await client.callTool('browser_tabs', { browserSessionHandle: 'bs_0123456789abcdefgh' });
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
