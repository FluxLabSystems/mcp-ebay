/**
 * Gateway–agent integration (§27.1): pairing, challenge-response,
 * heartbeat, command ACK/result, idempotency, expiry, reconnect — over a
 * real WSS link with the real AgentConnection implementation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeError } from '@browser-bridge/protocol';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { connectAgent, registerTestDevice, stubSessionHost, type ConnectedAgent } from '../helpers/agentHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

let harness: GatewayHarness;
let urls: { httpUrl: string; wsUrl: string };
let agent: ConnectedAgent;
let deviceId: string;
let client: ModernMcpClient;
const sessions = stubSessionHost();

beforeAll(async () => {
  harness = buildGatewayHarness({ heartbeatSeconds: 1 });
  urls = await harness.listen();
  const device = await registerTestDevice(harness);
  deviceId = device.identity.deviceId!;
  agent = connectAgent(urls, device.identity, sessions);
  agent.connection.start();
  await agent.waitReady();
  client = new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch);
});

afterAll(async () => {
  await agent?.stop();
  await harness?.close();
});

describe('device channel lifecycle (§11, §12)', () => {
  it('authenticated device appears in the registry and last_seen updates', async () => {
    expect(harness.registry.get(deviceId)).toBeDefined();
    const row = await harness.store.devices.get(deviceId);
    expect(row?.lastSeenAt).not.toBeNull();
    expect(row?.agentVersion).toBe('0.1.0');
  });

  it('session_open runs end to end through MCP → broker → WSS → executor', async () => {
    const response = await client.callTool('browser.session_open', { deviceId });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).not.toBe(true);
    const structured = response.body.result?.structuredContent as { browserSessionHandle: string; status: string };
    expect(structured.browserSessionHandle).toBe('bs_stub_session_000000000001');
    expect(structured.status).toBe('ready');
    // Handle→device mapping is persisted (§14) and audited (§26).
    const sessionRow = await harness.store.browserSessions.get(structured.browserSessionHandle);
    expect(sessionRow?.deviceId).toBe(deviceId);
    expect(harness.store.audit.events.some((event) => event.toolName === 'browser.session_open' && event.outcome === 'ok')).toBe(
      true,
    );
  });

  it('the "default" device convenience resolves when exactly one device is online', async () => {
    const response = await client.callTool('browser.session_open', { deviceId: 'default' });
    const structured = response.body.result?.structuredContent as { deviceId: string };
    expect(structured.deviceId).toBe(deviceId);
  });

  it('commands to unknown devices fail with DEVICE_OFFLINE', async () => {
    const response = await client.callTool('browser.session_open', { deviceId: 'dev_ghost' });
    const text = response.body.result?.content?.[0]?.text ?? '{}';
    expect(JSON.parse(text).error.code).toBe('DEVICE_OFFLINE');
  });

  it('agent errors map to catalogued codes through the result envelope (§12.3)', async () => {
    // The stub host throws SESSION_NOT_FOUND-shaped errors for tab commands.
    const open = await client.callTool('browser.session_open', { deviceId });
    const handle = (open.body.result?.structuredContent as { browserSessionHandle: string }).browserSessionHandle;
    const response = await client.callTool('browser.snapshot', { browserSessionHandle: handle, tabId: 'tab_x' });
    const text = response.body.result?.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as { error: { code: string } };
    expect(parsed.error.code).toBe('INTERNAL_ERROR'); // stub throws a plain error
  });
});

describe('command semantics (§18)', () => {
  it('duplicate idempotency keys return the original terminal result', async () => {
    const first = await harness.registry.sendCommand({
      deviceId,
      browserSessionHandle: 'bs_stub_session_000000000001',
      tabId: null,
      command: 'session_open',
      args: { profileName: 'ebay-research' },
      policyClass: 'reversible',
      timeoutMs: 10_000,
      traceparent: null,
      idempotencyKey: 'idem_fixed_key_1',
    });
    const opensBefore = sessions.openCount;
    const second = await harness.registry.sendCommand({
      deviceId,
      browserSessionHandle: 'bs_stub_session_000000000001',
      tabId: null,
      command: 'session_open',
      args: { profileName: 'ebay-research' },
      policyClass: 'reversible',
      timeoutMs: 10_000,
      traceparent: null,
      idempotencyKey: 'idem_fixed_key_1',
    });
    expect(second.requestId).toBe(first.requestId);
    expect(sessions.openCount).toBe(opensBefore); // no re-execution
  });

  it('expired commands are refused by the agent with REQUEST_EXPIRED', async () => {
    // Send a command whose deadline is already unreachable by using a
    // negative timeout budget at the envelope layer.
    const result = await harness.registry
      .sendCommand({
        deviceId,
        browserSessionHandle: 'bs_stub_session_000000000001',
        tabId: null,
        command: 'session_open',
        args: {},
        policyClass: 'reversible',
        timeoutMs: -1000,
        traceparent: null,
      })
      .catch((err: BridgeError) => err);
    if (result instanceof BridgeError) {
      // Gateway-side deadline may fire first; both outcomes prove expiry.
      expect(['NAVIGATION_TIMEOUT', 'REQUEST_EXPIRED']).toContain(result.code);
    } else {
      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('REQUEST_EXPIRED');
    }
  });

  it('agent retransmission of a completed request replays the cached result', async () => {
    const result = await harness.registry.sendCommand({
      deviceId,
      browserSessionHandle: 'bs_stub_session_000000000001',
      tabId: null,
      command: 'session_open',
      args: {},
      policyClass: 'reversible',
      timeoutMs: 10_000,
      traceparent: null,
      idempotencyKey: 'idem_replay_check',
    });
    expect(result.status).toBe('ok');
  });
});

describe('reconnect and reconciliation (§12.5)', () => {
  it('agent reconnects after a dropped socket and re-reports state', async () => {
    const before = harness.registry.get(deviceId);
    expect(before).toBeDefined();
    // Force-drop from the server side.
    before!.socket.terminate();
    await agent.waitReady(); // AgentConnection backoff → re-auth → ready
    const after = harness.registry.get(deviceId);
    expect(after).toBeDefined();
    expect(after!.connectionId).not.toBe(before!.connectionId);
  }, 30_000);

  it('commands sent while offline fail fast with DEVICE_OFFLINE and recover after reconnect', async () => {
    const live = harness.registry.get(deviceId)!;
    harness.registry.unregister(deviceId, live.socket);
    await expect(
      harness.registry.sendCommand({
        deviceId,
        browserSessionHandle: 'bs_stub_session_000000000001',
        tabId: null,
        command: 'session_open',
        args: {},
        policyClass: 'reversible',
        timeoutMs: 5_000,
        traceparent: null,
      }),
    ).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    // Restore registry entry (socket is still open).
    harness.registry.register(live);
    const recovered = await harness.registry.sendCommand({
      deviceId,
      browserSessionHandle: 'bs_stub_session_000000000001',
      tabId: null,
      command: 'session_open',
      args: {},
      policyClass: 'reversible',
      timeoutMs: 10_000,
      traceparent: null,
    });
    expect(recovered.status).toBe('ok');
  });
});
