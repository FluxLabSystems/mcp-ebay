/**
 * DEVICE_OFFLINE enrichment (2026-09-03 deals-routine improvement report):
 * the payload must say which PC is down, when it was last seen and whether
 * another one is up, because the MCP surface has no device-listing tool.
 * Pure-function coverage of the store/registry join; the wire-level shape
 * is pinned in the contract and integration suites.
 */
import type WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { BridgeError, ERROR_CATALOG } from '@browser-bridge/protocol';
import {
  describeDeviceOffline,
  DeviceRegistry,
  deviceOfflineHint,
  KNOWN_DEVICES_LIMIT,
  MemoryStore,
  summarizeKnownDevices,
  withDeviceOfflineDetails,
  type DeviceRow,
  type KnownDeviceSummary,
} from '@browser-bridge/gateway';

/** Enough of a ws socket for the registry: readyState plus the two methods it calls. */
function fakeSocket(readyState: 1 | 2): WebSocket {
  return { readyState, OPEN: 1, CLOSING: 2, close: () => undefined, send: () => undefined } as unknown as WebSocket;
}

function row(deviceId: string, overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    deviceId,
    name: `pc-${deviceId}`,
    publicKeyEd25519: Buffer.from('unused'),
    keyFingerprint: `ed25519:${deviceId}`,
    status: 'active',
    agentVersion: null,
    pairedAt: new Date('2026-08-01T00:00:00Z'),
    lastSeenAt: null,
    ...overrides,
  };
}

function known(deviceId: string, overrides: Partial<KnownDeviceSummary> = {}): KnownDeviceSummary {
  return {
    deviceId,
    name: `pc-${deviceId}`,
    status: 'active',
    lastSeenAt: '2026-09-03T02:41:12.000Z',
    online: false,
    ...overrides,
  };
}

describe('DeviceRegistry online view', () => {
  it('onlineDeviceIds lists only registered connections whose socket is OPEN', () => {
    const registry = new DeviceRegistry();
    registry.register({ connectionId: 'c1', deviceId: 'dev_open', socket: fakeSocket(1), lastSeenAt: 0, agentVersion: '0' });
    registry.register({ connectionId: 'c2', deviceId: 'dev_closing', socket: fakeSocket(2), lastSeenAt: 0, agentVersion: '0' });
    expect(registry.onlineDeviceIds()).toEqual(['dev_open']);
  });

  it('resolveDeviceId echoes an unresolvable "default" back unchanged', () => {
    const registry = new DeviceRegistry();
    expect(registry.resolveDeviceId('default')).toBe('default');
    registry.register({ connectionId: 'c1', deviceId: 'dev_only', socket: fakeSocket(1), lastSeenAt: 0, agentVersion: '0' });
    expect(registry.resolveDeviceId('default')).toBe('dev_only');
    expect(registry.resolveDeviceId('dev_ghost')).toBe('dev_ghost');
  });
});

describe('summarizeKnownDevices', () => {
  it('orders most recently seen first, never-seen last, and flags the online ones', () => {
    const rows = [
      row('dev_never'),
      row('dev_old', { lastSeenAt: new Date('2026-09-01T00:00:00Z') }),
      row('dev_recent', { lastSeenAt: new Date('2026-09-03T02:41:12Z') }),
    ];
    const summary = summarizeKnownDevices(rows, ['dev_old']);
    expect(summary.map((device) => device.deviceId)).toEqual(['dev_recent', 'dev_old', 'dev_never']);
    expect(summary[0]).toEqual({
      deviceId: 'dev_recent',
      name: 'pc-dev_recent',
      status: 'active',
      lastSeenAt: '2026-09-03T02:41:12.000Z',
      online: false,
    });
    expect(summary[1]?.online).toBe(true);
    expect(summary[2]?.lastSeenAt).toBeNull();
  });

  it('breaks never-seen ties by newest pairing first', () => {
    const rows = [
      row('dev_paired_first', { pairedAt: new Date('2026-08-01T00:00:00Z') }),
      row('dev_paired_last', { pairedAt: new Date('2026-08-02T00:00:00Z') }),
    ];
    expect(summarizeKnownDevices(rows, []).map((device) => device.deviceId)).toEqual(['dev_paired_last', 'dev_paired_first']);
  });

  it('caps the list at KNOWN_DEVICES_LIMIT, keeping the most recently seen', () => {
    const many = Array.from({ length: KNOWN_DEVICES_LIMIT + 5 }, (_, i) =>
      row(`dev_${i}`, { lastSeenAt: new Date(1_000_000 + i * 1000) }),
    );
    const capped = summarizeKnownDevices(many, []);
    expect(capped).toHaveLength(KNOWN_DEVICES_LIMIT);
    expect(capped[0]?.deviceId).toBe(`dev_${KNOWN_DEVICES_LIMIT + 4}`);
    expect(capped.at(-1)?.deviceId).toBe('dev_5');
  });
});

describe('deviceOfflineHint', () => {
  const nothingOnline = { deviceId: 'default', resolvedDeviceId: null, onlineDeviceIds: [] as string[] };

  it('says so when nothing has ever been paired', () => {
    expect(deviceOfflineHint({ ...nothingOnline, knownDevices: [] })).toBe(
      'No Windows agent is connected and no device has been paired; pair one with device:pair on the gateway.',
    );
  });

  it('names the one PC and its last-seen time when "default" finds nothing online', () => {
    expect(deviceOfflineHint({ ...nothingOnline, knownDevices: [known('dev_a', { name: 'PC-ETHAN' })] })).toBe(
      'No Windows agent is connected; PC-ETHAN (dev_a) was last seen 2026-09-03T02:41:12.000Z.',
    );
  });

  it('says when the PC has never connected since pairing', () => {
    expect(deviceOfflineHint({ ...nothingOnline, knownDevices: [known('dev_a', { lastSeenAt: null })] })).toBe(
      'No Windows agent is connected; pc-dev_a (dev_a) has never connected since pairing.',
    );
  });

  it('prefers the most recently seen active device over a more recent revoked one', () => {
    const knownDevices = [
      known('dev_revoked', { status: 'revoked', lastSeenAt: '2026-09-03T03:00:00.000Z' }),
      known('dev_a'),
    ];
    expect(deviceOfflineHint({ ...nothingOnline, knownDevices })).toBe(
      'No Windows agent is connected; pc-dev_a (dev_a) was last seen 2026-09-03T02:41:12.000Z.',
    );
    expect(deviceOfflineHint({ ...nothingOnline, knownDevices: [knownDevices[0]!] })).toBe(
      'No Windows agent is connected; pc-dev_revoked (dev_revoked) was last seen 2026-09-03T03:00:00.000Z and is revoked.',
    );
  });

  it('flags a wrong id while nothing is online, still naming the PC that exists', () => {
    expect(
      deviceOfflineHint({ deviceId: 'dev_typo', resolvedDeviceId: 'dev_typo', onlineDeviceIds: [], knownDevices: [known('dev_a')] }),
    ).toBe(
      'No Windows agent is connected, and deviceId "dev_typo" is not a paired device; pc-dev_a (dev_a) was last seen 2026-09-03T02:41:12.000Z.',
    );
  });

  it('flags a wrong id while another PC is online and names that one', () => {
    expect(
      deviceOfflineHint({
        deviceId: 'dev_typo',
        resolvedDeviceId: 'dev_typo',
        onlineDeviceIds: ['dev_b'],
        knownDevices: [known('dev_b', { online: true })],
      }),
    ).toBe('deviceId "dev_typo" is not a paired device; connected: pc-dev_b (dev_b).');
  });

  it('describes a known PC that is down while another is up', () => {
    expect(
      deviceOfflineHint({
        deviceId: 'dev_a',
        resolvedDeviceId: 'dev_a',
        onlineDeviceIds: ['dev_b'],
        knownDevices: [known('dev_b', { online: true, lastSeenAt: '2026-09-03T07:00:00.000Z' }), known('dev_a')],
      }),
    ).toBe('pc-dev_a (dev_a) is not connected (was last seen 2026-09-03T02:41:12.000Z); connected: pc-dev_b (dev_b).');
  });

  it('explains an ambiguous "default" with several agents online', () => {
    expect(
      deviceOfflineHint({
        deviceId: 'default',
        resolvedDeviceId: null,
        onlineDeviceIds: ['dev_a', 'dev_b'],
        knownDevices: [known('dev_a', { online: true }), known('dev_b', { online: true })],
      }),
    ).toBe(
      'deviceId "default" did not resolve with 2 agents connected (pc-dev_a (dev_a), pc-dev_b (dev_b)); pass one of those ids explicitly.',
    );
  });

  it('distinguishes a connected-but-silent device (ack timeout, mid-command drop) from an absent one', () => {
    expect(
      deviceOfflineHint({
        deviceId: 'default',
        resolvedDeviceId: 'dev_a',
        onlineDeviceIds: ['dev_a'],
        knownDevices: [known('dev_a', { online: true })],
      }),
    ).toBe('pc-dev_a (dev_a) is connected but did not answer the command; retry, and check the agent console if it persists.');
  });
});

describe('describeDeviceOffline + withDeviceOfflineDetails', () => {
  it('joins the store and the registry into the payload the routine asked for', async () => {
    const store = new MemoryStore();
    await store.devices.insert(row('dev_a', { name: 'PC-ETHAN', lastSeenAt: new Date('2026-09-03T02:41:12Z') }));
    const registry = new DeviceRegistry();
    const details = await describeDeviceOffline(
      { devices: store.devices, registry },
      { requestedDeviceId: 'default', resolvedDeviceId: null },
    );
    expect(details).toEqual({
      deviceId: 'default',
      resolvedDeviceId: null,
      onlineDeviceIds: [],
      knownDevices: [{ deviceId: 'dev_a', name: 'PC-ETHAN', status: 'active', lastSeenAt: '2026-09-03T02:41:12.000Z', online: false }],
      hint: 'No Windows agent is connected; PC-ETHAN (dev_a) was last seen 2026-09-03T02:41:12.000Z.',
    });
  });

  it('keeps code, retryability and the base message, appends the hint, and preserves prior details', async () => {
    const store = new MemoryStore();
    await store.devices.insert(row('dev_a'));
    const details = await describeDeviceOffline(
      { devices: store.devices, registry: new DeviceRegistry() },
      { requestedDeviceId: 'default', resolvedDeviceId: null },
    );

    // The registry's ack-timeout shape: custom message plus a requestId.
    const acked = withDeviceOfflineDetails(
      new BridgeError('DEVICE_OFFLINE', 'Agent did not acknowledge the command.', { requestId: 'req_1' }),
      details,
    );
    expect(acked.code).toBe('DEVICE_OFFLINE');
    expect(acked.retryable).toBe(true);
    expect(acked.message).toBe(`Agent did not acknowledge the command. ${details.hint}`);
    expect(acked.details).toEqual({ requestId: 'req_1', ...details });

    // The default shape, as the deals routine saw it on 2026-09-03: the
    // catalog message survives as a prefix and the requested id wins.
    const plain = withDeviceOfflineDetails(new BridgeError('DEVICE_OFFLINE', undefined, { deviceId: 'default' }), details);
    expect(plain.message).toBe(`${ERROR_CATALOG.DEVICE_OFFLINE.message} ${details.hint}`);
    expect(plain.toPayload()).toMatchObject({ code: 'DEVICE_OFFLINE', retryable: true, details });

    // Applying it twice does not append the hint twice.
    expect(withDeviceOfflineDetails(plain, details).message).toBe(plain.message);
  });
});
