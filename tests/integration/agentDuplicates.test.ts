/**
 * Agent duplicate-command handling (audit F-16), driven through a fake
 * WebSocket so frames can be retransmitted deliberately:
 *   completed request  → cached result frame replayed, no re-execution
 *   in-flight request  → duplicate ignored, exactly one execution
 */
import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import {
  generateDeviceKeyPair,
  publicKeyFingerprint,
  WIRE_PROTOCOL_VERSION,
  type CommandEnvelope,
} from '@browser-bridge/protocol';
import { AgentConnection, type ExecutorHost } from '@browser-bridge/windows-agent';
import { stubSessionHost } from '../helpers/agentHarness.js';

class FakeSocket extends EventEmitter {
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
}

function makeEnvelope(requestId: string): CommandEnvelope {
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    type: 'command',
    requestId,
    deviceId: 'dev_fake',
    browserSessionHandle: 'bs_stub_session_000000000001',
    tabId: null,
    command: 'session_open',
    arguments: { profileName: 'ebay-research' },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    idempotencyKey: `idem_${requestId}`,
    policyClass: 'reversible',
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

describe('agent duplicate-command guards (F-16)', () => {
  it('executes a retransmitted request exactly once and replays completed results', async () => {
    const socket = new FakeSocket();
    const pair = generateDeviceKeyPair();
    let executions = 0;
    let releaseExecution: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });

    const host: ExecutorHost = {
      sessions: stubSessionHost(),
      logger: pino({ level: 'silent' }),
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
      logger: pino({ level: 'silent' }),
      heartbeatSeconds: 60,
      webSocketFactory: () => socket as unknown as WebSocket,
      executeCommandImpl: async () => {
        executions += 1;
        await gate; // hold the first execution in flight
        return { result: { ok: true }, pageRevision: null, artifacts: [] };
      },
    });
    connection.start();
    socket.emit('open');
    // Authenticate the channel so command frames are accepted.
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
        artifactToken: 'at.ZmFrZQ.9999999999.sig',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }),
    );

    const envelope = makeEnvelope('01JDUPLICATE0000000000000');
    socket.emit('message', JSON.stringify(envelope));
    await until(() => executions === 1);
    // Retransmit while the first execution is still in flight.
    socket.emit('message', JSON.stringify(envelope));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(executions).toBe(1);

    // Let the execution finish and its result frame go out.
    releaseExecution!();
    await until(() => socket.sent.some((frame) => frame.includes('"type":"result"')));
    const resultFrames = socket.sent.filter((frame) => frame.includes('"type":"result"'));
    expect(resultFrames).toHaveLength(1);

    // Retransmit after completion: the cached result frame is replayed
    // verbatim with no re-execution.
    socket.emit('message', JSON.stringify(envelope));
    await until(() => socket.sent.filter((frame) => frame.includes('"type":"result"')).length === 2);
    expect(executions).toBe(1);
    const replayed = socket.sent.filter((frame) => frame.includes('"type":"result"'));
    expect(replayed[0]).toBe(replayed[1]);

    await connection.stop();
  });
});
