/**
 * WSS device channel server side — SDD v0.5 §11 (challenge-response),
 * §12 (control messages, heartbeat), §12.5 (reconnect reconciliation).
 */
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import {
  AgentToGatewayMessageSchema,
  newChallengeNonce,
  parseWireMessage,
  timestampWithinSkew,
  verifyChallengeSignature,
  WIRE_PROTOCOL_VERSION,
  type AgentToGatewayMessage,
} from '@browser-bridge/protocol';
import type { Logger } from 'pino';
import type { ArtifactTokenIssuer } from '../agentAuth.js';
import type { Store } from '../store/types.js';
import type { DeviceRegistry } from './registry.js';

export interface WsHandlerDeps {
  store: Store;
  registry: DeviceRegistry;
  artifactTokens: ArtifactTokenIssuer;
  logger: Logger;
  heartbeatSeconds: number;
}

/** Nonces are single-use; reuse within the window is a replay (§27.2). */
const usedNonces = new Map<string, number>();

function pruneNonces(): void {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [nonce, at] of usedNonces) {
    if (at < cutoff) usedNonces.delete(nonce);
  }
}

export function handleAgentSocket(socket: WebSocket, deps: WsHandlerDeps): void {
  const nonce = newChallengeNonce();
  const nonceBase64 = nonce.toString('base64');
  let authenticatedDeviceId: string | null = null;
  let connectionId: string | null = null;
  let lastActivity = Date.now();

  socket.send(
    JSON.stringify({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      type: 'device.challenge',
      nonce: nonceBase64,
      issuedAt: new Date().toISOString(),
    }),
  );

  const authTimeout = setTimeout(() => {
    if (authenticatedDeviceId === null) socket.close(4401, 'authentication timeout');
  }, 15_000);

  const heartbeatInterval = setInterval(() => {
    if (authenticatedDeviceId === null || connectionId === null) return;
    socket.send(
      JSON.stringify({
        protocolVersion: WIRE_PROTOCOL_VERSION,
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        connectionId,
      }),
    );
    // §12.4: 3 missed heartbeats marks the device offline.
    if (Date.now() - lastActivity > deps.heartbeatSeconds * 3 * 1000) {
      deps.logger.warn({ deviceId: authenticatedDeviceId }, 'Device heartbeat lost; terminating');
      socket.terminate();
    }
  }, deps.heartbeatSeconds * 1000);
  heartbeatInterval.unref?.();

  socket.on('message', (data) => {
    lastActivity = Date.now();
    void (async () => {
      let message: AgentToGatewayMessage;
      try {
        message = parseWireMessage(String(data), AgentToGatewayMessageSchema);
      } catch (err) {
        deps.logger.warn({ err: String(err) }, 'Malformed agent frame');
        if (authenticatedDeviceId === null) socket.close(4400, 'malformed frame');
        return;
      }

      if (message.type === 'device.hello') {
        pruneNonces();
        const device = await deps.store.devices.get(message.deviceId);
        const failures: string[] = [];
        if (device === null) failures.push('unknown device');
        if (device !== null && device.status !== 'active') failures.push('device revoked');
        if (!timestampWithinSkew(message.timestamp)) failures.push('timestamp skew');
        if (usedNonces.has(nonceBase64)) failures.push('nonce replay');
        if (device !== null && device.keyFingerprint !== message.publicKeyFingerprint) failures.push('fingerprint mismatch');
        if (
          device !== null &&
          !verifyChallengeSignature(
            device.publicKeyEd25519.toString('utf8'),
            message.signature,
            nonce,
            message.deviceId,
            message.timestamp,
            message.agentVersion,
          )
        ) {
          failures.push('bad signature');
        }
        if (failures.length > 0) {
          deps.logger.warn({ deviceId: message.deviceId, failures }, 'Device authentication failed');
          socket.close(4401, 'DEVICE_UNAUTHORIZED');
          return;
        }
        usedNonces.set(nonceBase64, Date.now());
        authenticatedDeviceId = message.deviceId;
        connectionId = `conn_${randomUUID()}`;
        clearTimeout(authTimeout);
        deps.registry.register({
          connectionId,
          deviceId: message.deviceId,
          socket,
          lastSeenAt: Date.now(),
          agentVersion: message.agentVersion,
        });
        await deps.store.devices.touchLastSeen(message.deviceId, new Date(), message.agentVersion);
        const artifactToken = deps.artifactTokens.issue(message.deviceId);
        socket.send(
          JSON.stringify({
            protocolVersion: WIRE_PROTOCOL_VERSION,
            type: 'device.ready',
            connectionId,
            artifactToken: artifactToken.token,
            expiresAt: artifactToken.expiresAt.toISOString(),
          }),
        );
        deps.logger.info({ deviceId: message.deviceId, connectionId }, 'Device authenticated');
        return;
      }

      if (authenticatedDeviceId === null) {
        socket.close(4401, 'not authenticated');
        return;
      }
      deps.registry.touch(authenticatedDeviceId);

      switch (message.type) {
        case 'heartbeat':
          return;
        case 'ack':
          deps.registry.markAcked(message.requestId);
          return;
        case 'result': {
          const settled = deps.registry.settleResult(message);
          if (!settled) {
            deps.logger.debug({ requestId: message.requestId }, 'Result for unknown/expired request discarded');
          }
          return;
        }
        case 'state.report': {
          // §12.5: reconcile reported sessions with the handle→device map.
          const now = new Date();
          for (const session of message.sessions) {
            deps.registry.rememberSessionOwner(session.browserSessionHandle, authenticatedDeviceId);
            await deps.store.browserSessions.upsert({
              browserSessionHandle: session.browserSessionHandle,
              deviceId: authenticatedDeviceId,
              profileName: session.profileName,
              status: session.status,
              openedAt: now,
              lastSeenAt: now,
              closedAt: null,
            });
          }
          return;
        }
      }
    })();
  });

  socket.on('close', () => {
    clearTimeout(authTimeout);
    clearInterval(heartbeatInterval);
    if (authenticatedDeviceId !== null) {
      deps.registry.unregister(authenticatedDeviceId, socket);
      deps.logger.info({ deviceId: authenticatedDeviceId }, 'Device disconnected');
    }
  });
  socket.on('error', (err) => {
    deps.logger.warn({ err: String(err) }, 'Agent socket error');
  });
}
