/**
 * Live device connection registry and command routing — SDD v0.5 §12, §18.
 * Tracks authenticated WSS connections, pending requests, heartbeat
 * liveness, session→device mapping, and the 10-minute idempotency window.
 */
import type WebSocket from 'ws';
import {
  BridgeError,
  IDEMPOTENCY_WINDOW_SECONDS,
  newRequestId,
  ulid,
  WIRE_PROTOCOL_VERSION,
  type CommandEnvelope,
  type PolicyClass,
  type ResultEnvelope,
} from '@browser-bridge/protocol';

export interface LiveConnection {
  connectionId: string;
  deviceId: string;
  socket: WebSocket;
  lastSeenAt: number;
  agentVersion: string;
}

interface PendingRequest {
  requestId: string;
  deviceId: string;
  resolve: (result: ResultEnvelope) => void;
  reject: (err: BridgeError) => void;
  timer: NodeJS.Timeout;
  ackTimer: NodeJS.Timeout;
  acked: boolean;
}

interface IdempotencyEntry {
  at: number;
  result: ResultEnvelope | null;
  requestId: string;
}

/**
 * Catalogued error code for a command that exceeded its gateway deadline
 * (audit F-02): navigation deadlines are NAVIGATION_TIMEOUT; every other
 * command reports CONDITION_TIMEOUT. Both are retryable (§17).
 */
export function timeoutErrorCodeFor(command: string): 'NAVIGATION_TIMEOUT' | 'CONDITION_TIMEOUT' {
  return command === 'navigate' ? 'NAVIGATION_TIMEOUT' : 'CONDITION_TIMEOUT';
}

export interface SendCommandOptions {
  deviceId: string;
  browserSessionHandle: string;
  tabId: string | null;
  command: string;
  args: Record<string, unknown>;
  policyClass: PolicyClass;
  timeoutMs: number;
  traceparent: string | null;
  idempotencyKey?: string;
}

export class DeviceRegistry {
  private readonly connections = new Map<string, LiveConnection>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  /** browserSessionHandle → deviceId (runtime cache over the DB mapping). */
  private readonly sessionOwners = new Map<string, string>();

  register(connection: LiveConnection): void {
    const existing = this.connections.get(connection.deviceId);
    if (existing !== undefined && existing.socket !== connection.socket) {
      existing.socket.close(4000, 'superseded');
    }
    this.connections.set(connection.deviceId, connection);
  }

  unregister(deviceId: string, socket: WebSocket): void {
    const existing = this.connections.get(deviceId);
    if (existing !== undefined && existing.socket === socket) {
      this.connections.delete(deviceId);
    }
    for (const request of [...this.pending.values()]) {
      if (request.deviceId === deviceId) {
        this.settleError(request.requestId, new BridgeError('DEVICE_OFFLINE'));
      }
    }
  }

  get(deviceId: string): LiveConnection | undefined {
    return this.connections.get(deviceId);
  }

  list(): LiveConnection[] {
    return [...this.connections.values()];
  }

  touch(deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (connection !== undefined) connection.lastSeenAt = Date.now();
  }

  /** Resolve the target device: exact id, or "default" when unambiguous. */
  resolveDeviceId(requested: string): string {
    if (this.connections.has(requested)) return requested;
    if (requested === 'default') {
      const online = [...this.connections.keys()];
      if (online.length === 1) return online[0]!;
    }
    return requested;
  }

  rememberSessionOwner(handle: string, deviceId: string): void {
    this.sessionOwners.set(handle, deviceId);
  }

  sessionOwner(handle: string): string | undefined {
    return this.sessionOwners.get(handle);
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  pendingDevice(requestId: string): string | undefined {
    return this.pending.get(requestId)?.deviceId;
  }

  /**
   * Send a command envelope and await its terminal result (§12, §18).
   * Duplicate idempotency keys inside the window return the original
   * terminal result when available.
   */
  async sendCommand(options: SendCommandOptions): Promise<ResultEnvelope> {
    const idempotencyKey = options.idempotencyKey ?? `idem_${ulid()}`;
    this.pruneIdempotency();
    const duplicate = this.idempotency.get(idempotencyKey);
    if (duplicate !== undefined) {
      if (duplicate.result !== null) return duplicate.result;
      throw new BridgeError('RATE_LIMITED', 'Duplicate command submission is still in flight.', {
        idempotencyKey,
      });
    }

    const connection = this.connections.get(options.deviceId);
    if (connection === undefined || connection.socket.readyState !== connection.socket.OPEN) {
      throw new BridgeError('DEVICE_OFFLINE', undefined, { deviceId: options.deviceId });
    }

    const requestId = newRequestId();
    const now = Date.now();
    const envelope: CommandEnvelope = {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      type: 'command',
      requestId,
      deviceId: options.deviceId,
      browserSessionHandle: options.browserSessionHandle,
      tabId: options.tabId,
      command: options.command,
      arguments: options.args,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + options.timeoutMs).toISOString(),
      idempotencyKey,
      policyClass: options.policyClass,
      traceparent: options.traceparent,
    };
    this.idempotency.set(idempotencyKey, { at: now, result: null, requestId });

    return new Promise<ResultEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleError(
          requestId,
          new BridgeError(
            timeoutErrorCodeFor(options.command),
            `Command ${options.command} timed out after ${options.timeoutMs} ms.`,
            { command: options.command, requestId },
          ),
        );
        this.cancel(requestId, 'deadline exceeded', options.deviceId);
      }, options.timeoutMs + 2000);
      // §12.4: ack expected within 2 s; a silent agent is treated as offline.
      const ackTimer = setTimeout(() => {
        const request = this.pending.get(requestId);
        if (request !== undefined && !request.acked) {
          this.settleError(
            requestId,
            new BridgeError('DEVICE_OFFLINE', 'Agent did not acknowledge the command.', { requestId }),
          );
        }
      }, 4000);
      this.pending.set(requestId, {
        requestId,
        deviceId: options.deviceId,
        resolve: (result) => {
          const entry = this.idempotency.get(idempotencyKey);
          if (entry !== undefined) entry.result = result;
          resolve(result);
        },
        reject,
        timer,
        ackTimer,
        acked: false,
      });
      connection.socket.send(JSON.stringify(envelope), (err?: Error) => {
        if (err) {
          this.settleError(requestId, new BridgeError('DEVICE_OFFLINE', `Send failed: ${err.message}`));
        }
      });
    });
  }

  markAcked(requestId: string): void {
    const request = this.pending.get(requestId);
    if (request !== undefined) {
      request.acked = true;
      clearTimeout(request.ackTimer);
    }
  }

  settleResult(result: ResultEnvelope): boolean {
    const request = this.pending.get(result.requestId);
    if (request === undefined) return false;
    clearTimeout(request.timer);
    clearTimeout(request.ackTimer);
    this.pending.delete(result.requestId);
    request.resolve(result);
    return true;
  }

  settleError(requestId: string, err: BridgeError): void {
    const request = this.pending.get(requestId);
    if (request === undefined) return;
    clearTimeout(request.timer);
    clearTimeout(request.ackTimer);
    this.pending.delete(requestId);
    request.reject(err);
  }

  /** Best-effort cancel, targeted at the owning device only (audit F-10). */
  private cancel(requestId: string, reason: string, deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (connection === undefined) return;
    connection.socket.send(
      JSON.stringify({
        protocolVersion: WIRE_PROTOCOL_VERSION,
        type: 'cancel',
        requestId,
        reason,
      }),
    );
  }

  private pruneIdempotency(): void {
    const cutoff = Date.now() - IDEMPOTENCY_WINDOW_SECONDS * 1000;
    for (const [key, entry] of this.idempotency) {
      if (entry.at < cutoff) this.idempotency.delete(key);
    }
  }
}
