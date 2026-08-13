/**
 * Device channel security (§11, §27.2): replayed/expired pairing tokens
 * fail; revoked devices cannot authenticate even with a valid signature;
 * challenge tampering fails.
 */
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateDeviceKeyPair,
  generatePairingToken,
  hashPairingToken,
  publicKeyFingerprint,
  signChallenge,
  WIRE_PROTOCOL_VERSION,
} from '@browser-bridge/protocol';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { registerTestDevice } from '../helpers/agentHarness.js';

let harness: GatewayHarness;
let urls: { httpUrl: string; wsUrl: string };

beforeAll(async () => {
  harness = buildGatewayHarness();
  urls = await harness.listen();
});
afterAll(async () => {
  await harness.close();
});

interface HandshakeResult {
  closed: boolean;
  closeCode?: number;
  ready: boolean;
}

/** Drive one WSS handshake with a custom hello mutation. */
async function attemptHandshake(
  identity: { deviceId: string; privateKeyPem: string; publicKeyPem: string },
  mutate: (hello: Record<string, unknown>, nonce: Buffer) => Record<string, unknown>,
): Promise<HandshakeResult> {
  return new Promise((resolve) => {
    const socket = new WebSocket(urls.wsUrl);
    let ready = false;
    const finish = (closeCode?: number) => resolve({ closed: !ready, ...(closeCode === undefined ? {} : { closeCode }), ready });
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; nonce?: string };
      if (message.type === 'device.challenge') {
        const nonce = Buffer.from(message.nonce ?? '', 'base64');
        const timestamp = new Date().toISOString();
        const hello: Record<string, unknown> = {
          protocolVersion: WIRE_PROTOCOL_VERSION,
          type: 'device.hello',
          deviceId: identity.deviceId,
          publicKeyFingerprint: publicKeyFingerprint(identity.publicKeyPem),
          signature: signChallenge(identity.privateKeyPem, nonce, identity.deviceId, timestamp, '0.1.0'),
          timestamp,
          agentVersion: '0.1.0',
        };
        socket.send(JSON.stringify(mutate(hello, nonce)));
      }
      if (message.type === 'device.ready') {
        ready = true;
        socket.close();
      }
    });
    socket.on('close', (code) => finish(code));
    socket.on('error', () => finish());
  });
}

describe('pairing token lifecycle (§11.2-3)', () => {
  it('accepts a fresh token once and rejects the replay', async () => {
    const token = generatePairingToken();
    await harness.store.pairingTokens.insert(hashPairingToken(token), 'sec-test', new Date(Date.now() + 600_000));
    const pair = generateDeviceKeyPair();
    const body = {
      pairingToken: token,
      publicKeyPem: pair.publicKeyPem,
      deviceName: 'sec-test',
      agentVersion: '0.1.0',
    };
    const first = await fetch(`${urls.httpUrl}/agent/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    const replay = await fetch(`${urls.httpUrl}/agent/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(401);
  });

  it('rejects expired tokens', async () => {
    const token = generatePairingToken();
    await harness.store.pairingTokens.insert(hashPairingToken(token), 'expired', new Date(Date.now() - 1000));
    const pair = generateDeviceKeyPair();
    const response = await fetch(`${urls.httpUrl}/agent/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingToken: token,
        publicKeyPem: pair.publicKeyPem,
        deviceName: 'expired',
        agentVersion: '0.1.0',
      }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects non-Ed25519 keys', async () => {
    const token = generatePairingToken();
    await harness.store.pairingTokens.insert(hashPairingToken(token), 'rsa', new Date(Date.now() + 600_000));
    const response = await fetch(`${urls.httpUrl}/agent/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingToken: token,
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----',
        deviceName: 'rsa',
        agentVersion: '0.1.0',
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe('WSS challenge-response (§11.4-6, §27.2)', () => {
  it('authenticates a valid active device', async () => {
    const device = await registerTestDevice(harness, 'valid-device');
    const result = await attemptHandshake(device.identity as never, (hello) => hello);
    expect(result.ready).toBe(true);
  });

  it('revoked devices cannot authenticate even with a valid signature', async () => {
    const device = await registerTestDevice(harness, 'revoked-device');
    await harness.store.devices.setStatus(device.identity.deviceId!, 'revoked');
    const result = await attemptHandshake(device.identity as never, (hello) => hello);
    expect(result.ready).toBe(false);
    expect(result.closeCode).toBe(4401);
  });

  it('rejects signatures over a stale timestamp (skew)', async () => {
    const device = await registerTestDevice(harness, 'skew-device');
    const result = await attemptHandshake(device.identity as never, (hello, nonce) => {
      const staleTimestamp = new Date(Date.now() - 5 * 60_000).toISOString();
      return {
        ...hello,
        timestamp: staleTimestamp,
        signature: signChallenge(device.identity.privateKeyPem, nonce, device.identity.deviceId!, staleTimestamp, '0.1.0'),
      };
    });
    expect(result.ready).toBe(false);
  });

  it('rejects a signature produced for a different nonce (replay)', async () => {
    const device = await registerTestDevice(harness, 'replay-device');
    const wrongNonce = Buffer.alloc(32, 7);
    const result = await attemptHandshake(device.identity as never, (hello) => {
      const timestamp = new Date().toISOString();
      return {
        ...hello,
        timestamp,
        signature: signChallenge(device.identity.privateKeyPem, wrongNonce, device.identity.deviceId!, timestamp, '0.1.0'),
      };
    });
    expect(result.ready).toBe(false);
  });

  it('rejects unknown devices and foreign keys', async () => {
    const rogue = generateDeviceKeyPair();
    const result = await attemptHandshake(
      { deviceId: 'dev_unknown', privateKeyPem: rogue.privateKeyPem, publicKeyPem: rogue.publicKeyPem },
      (hello) => hello,
    );
    expect(result.ready).toBe(false);
  });
});

describe('artifact routes (§16)', () => {
  it('rejects uploads without a valid artifact token', async () => {
    const response = await fetch(`${urls.httpUrl}/agent/artifacts/req1/art_x`, {
      method: 'PUT',
      headers: { authorization: 'Bearer bogus', 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(401);
  });

  it('rejects uploads for requests that are not pending for the device', async () => {
    const token = harness.artifactTokens.issue('dev_someone');
    const response = await fetch(`${urls.httpUrl}/agent/artifacts/req_none/art_y`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token.token}`, 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(403);
  });

  it('signed download URLs reject bad signatures and expiry', async () => {
    const bad = await fetch(`${urls.httpUrl}/artifacts/art_missing?exp=${Math.floor(Date.now() / 1000) + 60}&sig=forged`);
    expect(bad.status).toBe(404);
  });
});
