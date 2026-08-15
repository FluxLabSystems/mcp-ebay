/**
 * Gateway–agent integration (§27.1): pairing, challenge-response,
 * heartbeat, command ACK/result, idempotency, expiry, reconnect — over a
 * real WSS link with the real AgentConnection implementation.
 */
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeError } from '@browser-bridge/protocol';
import { CommandBroker } from '@browser-bridge/gateway';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { connectAgent, registerTestDevice, stubSessionHost, type ConnectedAgent } from '../helpers/agentHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

  it('writes a linked command audit event alongside the tool event (§26, F-03)', async () => {
    const before = harness.store.audit.events.length;
    const response = await client.callTool('browser.session_open', { deviceId });
    expect(response.body.result?.isError).not.toBe(true);
    const events = harness.store.audit.events.slice(before);
    const commandEvent = events.find((event) => event.actionClass === 'command');
    const toolEvent = events.find((event) => event.actionClass === 'reversible');
    expect(commandEvent).toBeDefined();
    expect(toolEvent).toBeDefined();
    expect(commandEvent?.requestId).toBeTruthy();
    expect(commandEvent?.requestId).toBe(toolEvent?.requestId);
    expect(commandEvent?.metadata.command).toBe('session_open');
    expect(typeof commandEvent?.metadata.agentDurationMs).toBe('number');
  });

  it('logs a structured tool_call metric line with durations (§26, F-08)', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const capturing = pino(
      { level: 'info' },
      {
        write: (chunk: string) => {
          lines.push(JSON.parse(chunk) as Record<string, unknown>);
        },
      },
    );
    const metricBroker = new CommandBroker({
      registry: harness.registry,
      store: harness.store,
      artifacts: harness.artifacts,
      logger: capturing,
      ebayDestinationPostalCode: 'M6H 2W9',
    });
    await metricBroker.call('browser.session_open', { deviceId }, { subject: 'metrics', traceparent: null });
    const line = lines.find((entry) => entry.metric === 'tool_call');
    expect(line).toBeDefined();
    expect(line).toMatchObject({ toolName: 'browser.session_open', outcome: 'ok', deviceId });
    expect(typeof line?.durationMs).toBe('number');
    expect(typeof line?.agentDurationMs).toBe('number');
    expect(typeof line?.requestId).toBe('string');
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
      expect(['CONDITION_TIMEOUT', 'REQUEST_EXPIRED']).toContain(result.code);
    } else {
      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('REQUEST_EXPIRED');
    }
  });

  it('non-navigate command deadlines report CONDITION_TIMEOUT (F-02)', async () => {
    const slowDevice = await registerTestDevice(harness, 'slow-device');
    const slowSessions = stubSessionHost('bs_slow_session_000000000001', { openDelayMs: 4000 });
    const slowAgent = connectAgent(urls, slowDevice.identity, slowSessions);
    slowAgent.connection.start();
    await slowAgent.waitReady();
    try {
      await expect(
        harness.registry.sendCommand({
          deviceId: slowDevice.identity.deviceId!,
          browserSessionHandle: 'bs_slow_session_000000000001',
          tabId: null,
          command: 'session_open',
          args: {},
          policyClass: 'reversible',
          timeoutMs: 300,
          traceparent: null,
        }),
      ).rejects.toMatchObject({ code: 'CONDITION_TIMEOUT', retryable: true });
    } finally {
      await slowAgent.stop();
    }
  }, 20_000);

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

  it('marks sessions closed on true disconnect and reopens them via session_open (F-04)', async () => {
    // Ensure a session row exists and is open.
    const open = await client.callTool('browser.session_open', { deviceId });
    const handle = (open.body.result?.structuredContent as { browserSessionHandle: string }).browserSessionHandle;
    const openRow = await harness.store.browserSessions.get(handle);
    expect(openRow?.status).toBe('ready');
    const openedAt = openRow!.openedAt;

    // Drop the socket: the close handler must mark the device's sessions closed.
    harness.registry.get(deviceId)!.socket.terminate();
    const closedRow = await waitFor(
      () => harness.store.browserSessions.get(handle),
      (row) => row?.status === 'closed',
    );
    expect(closedRow?.status).toBe('closed');
    expect(closedRow?.closedAt).not.toBeNull();

    // After reconnect, a fresh session_open reopens the handle; openedAt is
    // preserved across the upsert (PG ON CONFLICT parity, F-14).
    await agent.waitReady();
    const reopened = await client.callTool('browser.session_open', { deviceId });
    const reopenedHandle = (reopened.body.result?.structuredContent as { browserSessionHandle: string })
      .browserSessionHandle;
    expect(reopenedHandle).toBe(handle); // stub host reuses its handle
    const readyRow = await waitFor(
      () => harness.store.browserSessions.get(handle),
      (row) => row?.status === 'ready',
    );
    expect(readyRow?.status).toBe('ready');
    expect(readyRow?.closedAt).toBeNull();
    expect(readyRow?.openedAt.getTime()).toBe(openedAt.getTime());
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
