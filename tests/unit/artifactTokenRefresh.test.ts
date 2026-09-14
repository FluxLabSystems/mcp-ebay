/**
 * Artifact-upload credential lifetime (§11.5/§16) — improvement queue
 * 2026-09-14 22:2xZ jobs fire, fingerprint
 * gateway+connector_defect+browser-screenshot-full-page-mode-fails-artifact-upload-http-401-while-viewport-succeeds.
 *
 * The gateway issues the artifact token once, at device.ready, with a
 * 15-minute TTL, and never again for the life of the socket. Every artifact
 * at or under WIRE_INLINE_ARTIFACT_MAX_BYTES (1 MiB) rides inline in the
 * result frame and never touches the token, so a 639 KB viewport screenshot
 * succeeded seconds after a full-page screenshot — which exceeded the inline
 * cap and PUT with the expired token — was refused 401 and surfaced as a
 * generic INTERNAL_ERROR "Artifact upload failed with HTTP 401." on a
 * session that had been open for longer than the TTL.
 *
 * Two halves, pinned here:
 *   gateway — a connected agent receives a fresh `device.token` frame over
 *             the socket before its current token expires (checked on the
 *             heartbeat tick once ARTIFACT_TOKEN_REFRESH_AFTER_SECONDS has
 *             elapsed since the last issue), so a long-lived session never
 *             holds an expired credential;
 *   agent   — the agent adopts the refreshed token for its next upload, and
 *             an upload the gateway refuses is reported as
 *             ARTIFACT_UPLOAD_FAILED (retryable) with the HTTP status, the
 *             artifact's size and whether the token had already expired by
 *             the agent's own clock — never as a bare INTERNAL_ERROR; 413 and
 *             415 keep their own codes (ARTIFACT_TOO_LARGE, DOWNLOAD_BLOCKED).
 */
import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_TOKEN_REFRESH_AFTER_SECONDS,
  ARTIFACT_TOKEN_TTL_SECONDS,
  BRIDGE_ERROR_CODES,
  ERROR_CATALOG,
  generateDeviceKeyPair,
  GatewayToAgentMessageSchema,
  parseWireMessage,
  publicKeyFingerprint,
  signChallenge,
  WIRE_INLINE_ARTIFACT_MAX_BYTES,
  WIRE_PROTOCOL_VERSION,
  type CommandEnvelope,
} from '@browser-bridge/protocol';
import { ArtifactTokenIssuer, DeviceRegistry, handleAgentSocket, MemoryStore } from '@browser-bridge/gateway';
import { AgentConnection, type ExecutorHost } from '@browser-bridge/windows-agent';
import { stubSessionHost } from '../helpers/agentHarness.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = WebSocket.OPEN;
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(String(data));
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate(): void {
    this.close();
  }
  frames(type: string): Array<Record<string, unknown>> {
    return this.sent
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((frame) => frame['type'] === type);
  }
}

const silent = pino({ level: 'silent' });

describe('artifact token refresh — gateway half', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-issues the artifact token over the socket before the 15-minute TTL elapses', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const registry = new DeviceRegistry();
    const issuer = new ArtifactTokenIssuer('unit-secret');
    const pair = generateDeviceKeyPair();
    const deviceId = 'dev_01UNITTOKENREFRESH0000000';
    await store.devices.insert({
      deviceId,
      name: 'unit',
      publicKeyEd25519: Buffer.from(pair.publicKeyPem, 'utf8'),
      keyFingerprint: publicKeyFingerprint(pair.publicKeyPem),
      status: 'active',
      agentVersion: null,
      pairedAt: new Date(),
      lastSeenAt: null,
    });
    const heartbeatSeconds = 10;
    const socket = new FakeSocket();
    handleAgentSocket(socket as unknown as WebSocket, {
      store,
      registry,
      artifactTokens: issuer,
      logger: silent,
      heartbeatSeconds,
    });

    // Handshake: challenge → signed hello → ready (token #1).
    const challenge = socket.frames('device.challenge')[0]!;
    const timestamp = new Date().toISOString();
    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: WIRE_PROTOCOL_VERSION,
        type: 'device.hello',
        deviceId,
        publicKeyFingerprint: publicKeyFingerprint(pair.publicKeyPem),
        signature: signChallenge(
          pair.privateKeyPem,
          Buffer.from(challenge['nonce'] as string, 'base64'),
          deviceId,
          timestamp,
          '0.1.0',
        ),
        timestamp,
        agentVersion: '0.1.0',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const ready = socket.frames('device.ready');
    expect(ready).toHaveLength(1);
    const firstToken = ready[0]!['artifactToken'] as string;
    expect(issuer.verify(firstToken)).toEqual({ deviceId });

    // The agent keeps talking (a heartbeat per interval) so the gateway's own
    // 3-missed-heartbeats guard never terminates the socket.
    const advance = async (seconds: number): Promise<void> => {
      for (let elapsed = 0; elapsed < seconds; elapsed += heartbeatSeconds) {
        socket.emit(
          'message',
          JSON.stringify({
            protocolVersion: WIRE_PROTOCOL_VERSION,
            type: 'heartbeat',
            timestamp: new Date().toISOString(),
            connectionId: ready[0]!['connectionId'],
          }),
        );
        await vi.advanceTimersByTimeAsync(heartbeatSeconds * 1000);
      }
    };

    // Nothing before the refresh point.
    await advance(ARTIFACT_TOKEN_REFRESH_AFTER_SECONDS - 2 * heartbeatSeconds);
    expect(socket.frames('device.token')).toHaveLength(0);

    // Past it: exactly one fresh token, valid, distinct, expiring later — and
    // well before the first token's own expiry.
    await advance(3 * heartbeatSeconds);
    const refreshed = socket.frames('device.token');
    expect(refreshed).toHaveLength(1);
    const second = refreshed[0]!;
    expect(second['protocolVersion']).toBe(WIRE_PROTOCOL_VERSION);
    expect(issuer.verify(second['artifactToken'] as string)).toEqual({ deviceId });
    expect(second['artifactToken']).not.toBe(firstToken);
    expect(new Date(second['expiresAt'] as string).getTime()).toBeGreaterThan(
      new Date(ready[0]!['expiresAt'] as string).getTime(),
    );
    expect(issuer.verify(firstToken)).toEqual({ deviceId }); // the old one is still good at this point
    // The frame is one the agent's wire schema accepts.
    expect(() => parseWireMessage(JSON.stringify(second), GatewayToAgentMessageSchema)).not.toThrow();

    // The cadence is once per refresh window, not once per heartbeat.
    await advance(3 * heartbeatSeconds);
    expect(socket.frames('device.token')).toHaveLength(1);

    // Across the whole original TTL the agent is never left holding only an
    // expired credential: the newest token issued verifies at every point.
    await advance(ARTIFACT_TOKEN_TTL_SECONDS);
    const all = socket.frames('device.token');
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(issuer.verify(all[all.length - 1]!['artifactToken'] as string)).toEqual({ deviceId });
    expect(issuer.verify(firstToken)).toBeNull(); // and the first one has indeed expired by now

    socket.close();
  });
});

function makeEnvelope(requestId: string): CommandEnvelope {
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    type: 'command',
    requestId,
    deviceId: 'dev_fake',
    browserSessionHandle: 'bs_stub_session_000000000001',
    tabId: 'tab_STUB0000000000000000000001',
    command: 'screenshot',
    arguments: { mode: 'full_page' },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    idempotencyKey: `idem_${requestId}`,
    policyClass: 'read',
    traceparent: null,
  };
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface UploadCall {
  authorization: string | null;
  url: string;
}

/** A connected agent whose every command yields one artifact above the inline cap. */
async function connectedAgent(respond: (call: UploadCall) => Response): Promise<{
  socket: FakeSocket;
  connection: AgentConnection;
  uploads: UploadCall[];
}> {
  const socket = new FakeSocket();
  const pair = generateDeviceKeyPair();
  const uploads: UploadCall[] = [];
  const host: ExecutorHost = {
    sessions: stubSessionHost(),
    logger: silent,
    expectedPostalCode: 'M6H 2W9',
  };
  const connection = new AgentConnection({
    gatewayWsUrl: 'ws://fake.invalid/agent/ws',
    gatewayHttpUrl: 'http://fake.invalid',
    identity: {
      deviceId: 'dev_fake',
      publicKeyPem: pair.publicKeyPem,
      privateKeyPem: pair.privateKeyPem,
      fingerprint: publicKeyFingerprint(pair.publicKeyPem),
      keyStoreKind: 'plainfile-dev',
    },
    host,
    logger: silent,
    heartbeatSeconds: 60,
    webSocketFactory: () => socket as unknown as WebSocket,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call = { authorization: headers.get('authorization'), url: String(input) };
      uploads.push(call);
      return respond(call);
    }) as typeof fetch,
    executeCommandImpl: async () => ({
      result: { ok: true },
      pageRevision: 8,
      artifacts: [
        {
          artifactId: 'art_01UNITFULLPAGE00000000000',
          mimeType: 'image/png',
          buffer: Buffer.alloc(WIRE_INLINE_ARTIFACT_MAX_BYTES + 1, 7),
        },
      ],
    }),
  });
  connection.start();
  socket.emit('open');
  socket.emit(
    'message',
    JSON.stringify({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      type: 'device.challenge',
      nonce: Buffer.alloc(32, 1).toString('base64'),
      issuedAt: new Date().toISOString(),
    }),
  );
  await until(() => socket.sent.some((frame) => frame.includes('device.hello')));
  socket.emit(
    'message',
    JSON.stringify({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      type: 'device.ready',
      connectionId: 'conn_fake',
      artifactToken: 'at.ZmFrZQ.1000000000.first',
      // Already in the past by the agent's clock: the token the gateway
      // issued at hello is what a session older than the TTL is holding.
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  return { socket, connection, uploads };
}

function resultFrames(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.frames('result');
}

describe('artifact token refresh — agent half', () => {
  it('catalogs ARTIFACT_UPLOAD_FAILED as a retryable code', () => {
    expect(BRIDGE_ERROR_CODES).toContain('ARTIFACT_UPLOAD_FAILED');
    expect(ERROR_CATALOG.ARTIFACT_UPLOAD_FAILED.retryable).toBe(true);
  });

  it('reports a 401 on upload as ARTIFACT_UPLOAD_FAILED with the status, size and token state — not INTERNAL_ERROR', async () => {
    const { socket, connection, uploads } = await connectedAgent(
      () => new Response(JSON.stringify({ error: 'invalid artifact token' }), { status: 401 }),
    );
    socket.emit('message', JSON.stringify(makeEnvelope('01JUPLOAD401000000000000000')));
    await until(() => resultFrames(socket).length === 1);
    const frame = resultFrames(socket)[0]!;
    expect(frame['status']).toBe('error');
    const error = frame['error'] as { code: string; retryable: boolean; message: string; details: Record<string, unknown> };
    expect(error.code).toBe('ARTIFACT_UPLOAD_FAILED');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('401');
    expect(error.details['httpStatus']).toBe(401);
    expect(error.details['artifactId']).toBe('art_01UNITFULLPAGE00000000000');
    expect(error.details['byteLength']).toBe(WIRE_INLINE_ARTIFACT_MAX_BYTES + 1);
    expect(error.details['inlineMaxBytes']).toBe(WIRE_INLINE_ARTIFACT_MAX_BYTES);
    expect(error.details['tokenExpired']).toBe(true);
    expect(typeof error.details['tokenExpiresAt']).toBe('string');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.authorization).toBe('Bearer at.ZmFrZQ.1000000000.first');
    await connection.stop();
  });

  it('adopts a device.token refresh for the next upload', async () => {
    const { socket, connection, uploads } = await connectedAgent((call) =>
      call.authorization === 'Bearer at.ZmFrZQ.2000000000.second'
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response(JSON.stringify({ error: 'invalid artifact token' }), { status: 401 }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        protocolVersion: WIRE_PROTOCOL_VERSION,
        type: 'device.token',
        artifactToken: 'at.ZmFrZQ.2000000000.second',
        expiresAt: new Date(Date.now() + ARTIFACT_TOKEN_TTL_SECONDS * 1000).toISOString(),
      }),
    );
    socket.emit('message', JSON.stringify(makeEnvelope('01JUPLOADREFRESH00000000000')));
    await until(() => resultFrames(socket).length === 1);
    const frame = resultFrames(socket)[0]!;
    expect(frame['status']).toBe('ok');
    const artifacts = frame['artifacts'] as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!['transfer']).toBe('uploaded');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.authorization).toBe('Bearer at.ZmFrZQ.2000000000.second');
    await connection.stop();
  });

  it('keeps the gateway’s own size and policy codes for 413 and 415', async () => {
    for (const [status, code] of [
      [413, 'ARTIFACT_TOO_LARGE'],
      [415, 'DOWNLOAD_BLOCKED'],
    ] as const) {
      const { socket, connection } = await connectedAgent(
        () => new Response(JSON.stringify({ error: code }), { status }),
      );
      socket.emit('message', JSON.stringify(makeEnvelope(`01JUPLOAD${status}0000000000000000`)));
      await until(() => resultFrames(socket).length === 1);
      const error = resultFrames(socket)[0]!['error'] as { code: string; details: Record<string, unknown> };
      expect(error.code).toBe(code);
      expect(error.details['httpStatus']).toBe(status);
      await connection.stop();
    }
  });
});
