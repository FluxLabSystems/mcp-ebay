/**
 * Outbound WSS device channel — SDD v0.5 §11 (challenge-response),
 * §12 (wire protocol), §12.5 (reconnect), §16 (artifact upload).
 * The Windows PC never accepts inbound connections.
 */
import WebSocket from 'ws';
import {
  AckSchema,
  BridgeError,
  CommandEnvelopeSchema,
  parseWireMessage,
  RECONNECT_BACKOFF_MS,
  RECONNECT_JITTER_RATIO,
  signChallenge,
  WIRE_INLINE_ARTIFACT_MAX_BYTES,
  WIRE_PROTOCOL_VERSION,
  GatewayToAgentMessageSchema,
  type CommandEnvelope,
  type GatewayToAgentMessage,
  type ResultEnvelope,
  type StateReport,
  type WireArtifact,
} from '@browser-bridge/protocol';
import { AGENT_VERSION } from './version.js';
import { executeCommand, type ExecutionOutcome, type ExecutorHost } from './executors.js';
import type { DeviceIdentity } from './identity.js';
import type { Logger } from './logger.js';

export interface ConnectionOptions {
  gatewayWsUrl: string;
  gatewayHttpUrl: string;
  identity: DeviceIdentity;
  host: ExecutorHost;
  logger: Logger;
  heartbeatSeconds: number;
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  webSocketFactory?: (url: string) => WebSocket;
  /** Injectable executor (transport tests exercise artifact paths with it). */
  executeCommandImpl?: (host: ExecutorHost, envelope: CommandEnvelope) => Promise<ExecutionOutcome>;
  onReady?: (connectionId: string) => void;
}

interface RecentResult {
  at: number;
  frame: string;
}

export class AgentConnection {
  private readonly options: ConnectionOptions;
  private readonly logger: Logger;
  private ws: WebSocket | null = null;
  private connectionId: string | null = null;
  private artifactToken: string | null = null;
  private stopped = false;
  private backoffIndex = 0;
  private failureSince: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastGatewayActivity = Date.now();
  private readonly cancelled = new Set<string>();
  private readonly recentResults = new Map<string, RecentResult>();

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.connectionId !== null;
  }

  private connect(): void {
    if (this.stopped) return;
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    this.logger.info({ url: this.options.gatewayWsUrl }, 'Connecting to gateway');
    const ws = factory(this.options.gatewayWsUrl);
    this.ws = ws;
    this.connectionId = null;
    this.artifactToken = null;

    ws.on('open', () => {
      this.lastGatewayActivity = Date.now();
    });
    ws.on('message', (data) => {
      this.lastGatewayActivity = Date.now();
      void this.onFrame(String(data));
    });
    ws.on('close', () => {
      this.onDisconnect('closed');
    });
    ws.on('error', (err) => {
      this.logger.warn({ err: String(err) }, 'WebSocket error');
      ws.close();
    });
  }

  private onDisconnect(reason: string): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.connectionId = null;
    this.artifactToken = null;
    this.ws = null;
    if (this.stopped) return;
    if (this.failureSince === null) this.failureSince = Date.now();

    // §12.5: 1,2,4,8,16,30 s max with 0-20% jitter; stay at 30 s after
    // 10 minutes of continuous failure.
    const tenMinutes = 10 * 60 * 1000;
    const index =
      Date.now() - this.failureSince >= tenMinutes
        ? RECONNECT_BACKOFF_MS.length - 1
        : Math.min(this.backoffIndex, RECONNECT_BACKOFF_MS.length - 1);
    const base = RECONNECT_BACKOFF_MS[index]!;
    const jitter = base * RECONNECT_JITTER_RATIO * Math.random();
    const delay = Math.round(base + jitter);
    this.backoffIndex = Math.min(this.backoffIndex + 1, RECONNECT_BACKOFF_MS.length - 1);
    this.logger.info({ reason, delayMs: delay }, 'Reconnecting after backoff');
    setTimeout(() => this.connect(), delay).unref?.();
  }

  private send(message: unknown): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private async onFrame(raw: string): Promise<void> {
    let message: GatewayToAgentMessage;
    try {
      message = parseWireMessage(raw, GatewayToAgentMessageSchema);
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'Discarding malformed gateway frame');
      return;
    }
    switch (message.type) {
      case 'device.challenge': {
        const deviceId = this.options.identity.deviceId;
        if (deviceId === null) {
          this.logger.error({}, 'Received challenge but device is not paired');
          this.ws?.close();
          return;
        }
        const timestamp = new Date().toISOString();
        const signature = signChallenge(
          this.options.identity.privateKeyPem,
          Buffer.from(message.nonce, 'base64'),
          deviceId,
          timestamp,
          AGENT_VERSION,
        );
        this.send({
          protocolVersion: WIRE_PROTOCOL_VERSION,
          type: 'device.hello',
          deviceId,
          publicKeyFingerprint: this.options.identity.fingerprint,
          signature,
          timestamp,
          agentVersion: AGENT_VERSION,
        });
        return;
      }
      case 'device.ready': {
        this.connectionId = message.connectionId;
        this.artifactToken = message.artifactToken;
        this.backoffIndex = 0;
        this.failureSince = null;
        this.logger.info({ connectionId: message.connectionId }, 'Device channel ready');
        this.startHeartbeat();
        this.sendStateReport();
        this.options.onReady?.(message.connectionId);
        return;
      }
      case 'heartbeat':
        return; // activity timestamp already updated
      case 'cancel': {
        this.cancelled.add(message.requestId);
        return;
      }
      case 'command': {
        await this.onCommand(message);
        return;
      }
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const intervalMs = this.options.heartbeatSeconds * 1000;
    this.heartbeatTimer = setInterval(() => {
      if (this.connectionId === null) return;
      this.send({
        protocolVersion: WIRE_PROTOCOL_VERSION,
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        connectionId: this.connectionId,
      });
      // §12.4: 3 missed heartbeats marks the peer offline.
      if (Date.now() - this.lastGatewayActivity > intervalMs * 3) {
        this.logger.warn({}, 'Gateway heartbeat lost; recycling connection');
        this.ws?.terminate();
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  /** §12.5: report active sessions/tabs after (re)connect for reconciliation. */
  private sendStateReport(): void {
    void (async () => {
      const sessions = this.options.host.sessions.listActive();
      const report: StateReport = {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        type: 'state.report',
        sessions: await Promise.all(
          sessions.map(async (session) => ({
            browserSessionHandle: session.handle,
            profileName: session.profileName,
            status: this.options.host.sessions.isDegraded ? ('degraded' as const) : ('ready' as const),
            tabs: await session.listTabs(),
          })),
        ),
      };
      this.send(report);
    })();
  }

  private async onCommand(envelope: CommandEnvelope): Promise<void> {
    CommandEnvelopeSchema.parse(envelope);
    // Retransmission of an already-completed request: replay the result.
    const recent = this.recentResults.get(envelope.requestId);
    if (recent !== undefined) {
      this.ws?.send(recent.frame);
      return;
    }
    // §12.4: ack within 2 s of queueing.
    this.send(
      AckSchema.parse({
        protocolVersion: WIRE_PROTOCOL_VERSION,
        type: 'ack',
        requestId: envelope.requestId,
        acceptedAt: new Date().toISOString(),
      }),
    );

    const started = Date.now();
    let result: ResultEnvelope;
    try {
      if (this.cancelled.has(envelope.requestId)) {
        throw new BridgeError('CANCELLED', undefined, { requestId: envelope.requestId });
      }
      const execute = this.options.executeCommandImpl ?? executeCommand;
      const outcome = await execute(this.options.host, envelope);
      const artifacts: WireArtifact[] = [];
      for (const artifact of outcome.artifacts) {
        if (artifact.buffer.length <= WIRE_INLINE_ARTIFACT_MAX_BYTES) {
          artifacts.push({
            artifactId: artifact.artifactId,
            mimeType: artifact.mimeType,
            byteLength: artifact.buffer.length,
            dataBase64: artifact.buffer.toString('base64'),
            transfer: 'inline',
          });
        } else {
          await this.uploadArtifact(envelope.requestId, artifact.artifactId, artifact.mimeType, artifact.buffer);
          artifacts.push({
            artifactId: artifact.artifactId,
            mimeType: artifact.mimeType,
            byteLength: artifact.buffer.length,
            dataBase64: null,
            transfer: 'uploaded',
          });
        }
      }
      result = {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        type: 'result',
        requestId: envelope.requestId,
        status: 'ok',
        pageRevision: outcome.pageRevision,
        result: outcome.result,
        artifacts,
        error: null,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const bridgeError = BridgeError.from(err);
      this.logger.warn(
        { requestId: envelope.requestId, command: envelope.command, code: bridgeError.code },
        'Command failed',
      );
      result = {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        type: 'result',
        requestId: envelope.requestId,
        status: 'error',
        pageRevision: null,
        result: null,
        artifacts: [],
        error: bridgeError.toPayload() as ResultEnvelope['error'],
        durationMs: Date.now() - started,
      };
    } finally {
      this.cancelled.delete(envelope.requestId);
    }
    const frame = JSON.stringify(result);
    this.recentResults.set(envelope.requestId, { at: Date.now(), frame });
    this.pruneRecentResults();
    this.ws?.send(frame);
  }

  private pruneRecentResults(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [requestId, entry] of this.recentResults) {
      if (entry.at < cutoff) this.recentResults.delete(requestId);
    }
  }

  /** §16: artifacts above the inline cap upload via authenticated PUT. */
  private async uploadArtifact(
    requestId: string,
    artifactId: string,
    mimeType: string,
    buffer: Buffer,
  ): Promise<void> {
    if (this.artifactToken === null) {
      throw new BridgeError('INTERNAL_ERROR', 'No artifact token available for upload.');
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `${this.options.gatewayHttpUrl}/agent/artifacts/${encodeURIComponent(requestId)}/${encodeURIComponent(artifactId)}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.artifactToken}`,
          'content-type': mimeType,
        },
        body: new Uint8Array(buffer),
      },
    );
    if (!response.ok) {
      throw new BridgeError('INTERNAL_ERROR', `Artifact upload failed with HTTP ${response.status}.`, {
        artifactId,
      });
    }
  }
}
