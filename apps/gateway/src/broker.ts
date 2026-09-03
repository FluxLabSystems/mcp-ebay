/**
 * Command broker — SDD v0.5 §15 (tool surface), §16 (artifacts), §18
 * (timeouts), §26 (audit). Maps MCP tool calls onto agent commands and
 * shapes results/artifacts for the MCP client.
 */
import { buildAuditEvent } from '@browser-bridge/audit';
import {
  BridgeError,
  BROWSER_SESSION_HANDLE_PATTERN,
  DEFAULT_PROFILE_NAME,
  isAllowedArtifactMime,
  isBridgeErrorCode,
  EXTRACT_FAMILY_COMMANDS,
  MCP_INLINE_ARTIFACT_MAX_BYTES,
  PENDING_SESSION_HANDLE,
  getToolEntry,
  type ArtifactDescriptor,
  type ResultEnvelope,
  type WireArtifact,
} from '@browser-bridge/protocol';
import type { Logger } from 'pino';
import type { ArtifactStore } from './artifacts/store.js';
import { describeDeviceOffline, withDeviceOfflineDetails } from './devices/offline.js';
import type { DeviceRegistry } from './devices/registry.js';
import type { Store } from './store/types.js';

/**
 * Per-call instrumentation sink, satisfied by @browser-bridge/telemetry's
 * CallRecorder. Declared structurally rather than imported so the gateway
 * takes no dependency on the telemetry package: a deployment that leaves
 * callRecorder unset runs the same code it ran before, and nothing is
 * serialized. Arguments and results are handed over whole and measured
 * there — the sink writes sizes, never values (§26).
 */
export interface ToolCallRecorderHook {
  record(observation: {
    toolName: string;
    args: unknown;
    response: unknown;
    durationMs: number;
    outcome: 'ok' | 'error' | 'denied';
    // Optional to match what a recorder is required to accept, not what the
    // broker happens to send: the broker always supplies all three, but a
    // sink that treats them as optional still satisfies this hook.
    errorCode?: string | null;
    sessionId?: string | null;
    requestId?: string | null;
  }): void;
}

export interface BrokerDeps {
  registry: DeviceRegistry;
  store: Store;
  artifacts: ArtifactStore;
  logger: Logger;
  /** §25: deployment-authoritative destination for ebay.ca.v1 extraction. */
  ebayDestinationPostalCode: string;
  /** Opt-in call-budget instrumentation; absent in every default path. */
  callRecorder?: ToolCallRecorderHook;
}

export interface CallerContext {
  subject: string | null;
  traceparent: string | null;
}

export interface BrokerArtifactOut {
  descriptor: ArtifactDescriptor;
  /** Present when delivered inline as MCP image content. */
  inlineBase64: string | null;
  mimeType: string;
  signedUrl: string | null;
}

export interface BrokerCallResult {
  structured: Record<string, unknown>;
  artifacts: BrokerArtifactOut[];
}

export class CommandBroker {
  constructor(private readonly deps: BrokerDeps) {}

  /**
   * Execute one MCP tool call through the paired device. Throws
   * BridgeError with catalogued codes (§17) on failure.
   */
  async call(toolName: string, args: Record<string, unknown>, caller: CallerContext): Promise<BrokerCallResult> {
    const entry = getToolEntry(toolName);
    if (entry === undefined) {
      throw new BridgeError('INTERNAL_ERROR', `Unknown tool ${toolName}.`);
    }

    /** deviceId as the caller expressed it, echoed in a DEVICE_OFFLINE payload. */
    let requestedDeviceId: string;
    let deviceId: string;
    let browserSessionHandle: string;
    let tabId: string | null = null;
    const commandArgs: Record<string, unknown> = { ...args };

    if (toolName === 'browser_session_open') {
      requestedDeviceId = String(args.deviceId ?? '');
      deviceId = this.deps.registry.resolveDeviceId(requestedDeviceId);
      browserSessionHandle = PENDING_SESSION_HANDLE;
      delete commandArgs.deviceId;
    } else {
      const handle = String(args.browserSessionHandle ?? '');
      if (!BROWSER_SESSION_HANDLE_PATTERN.test(handle)) {
        throw new BridgeError('SESSION_NOT_FOUND', `Malformed browserSessionHandle.`, { browserSessionHandle: handle });
      }
      browserSessionHandle = handle;
      const owner = this.deps.registry.sessionOwner(handle) ?? (await this.deps.store.browserSessions.get(handle))?.deviceId;
      if (owner === undefined) {
        throw new BridgeError('SESSION_NOT_FOUND', undefined, { browserSessionHandle: handle });
      }
      // The handle names the device; nothing else was asked for.
      requestedDeviceId = owner;
      deviceId = owner;
      delete commandArgs.browserSessionHandle;
      if ('tabId' in commandArgs) {
        tabId = String(commandArgs.tabId);
        delete commandArgs.tabId;
      }
    }

    // browser_handoff carries a user-configured wait; extend the deadline.
    const timeoutMs =
      toolName === 'browser_handoff'
        ? (Number(args.timeoutSeconds ?? 300) + 30) * 1000
        : entry.timeoutMs;

    // §25/§20.1: the gateway is the single source of truth for the
    // required shipping destination; it rides the wire envelope, never
    // the public tool schema (audit F-09).
    if (EXTRACT_FAMILY_COMMANDS.has(entry.command)) {
      commandArgs.destinationPostalCode = this.deps.ebayDestinationPostalCode;
    }

    const auditBase = {
      userSubject: caller.subject,
      deviceId,
      browserSessionHandle,
      tabId,
      toolName,
      actionClass: entry.policyClass,
      traceId: caller.traceparent,
    };
    const startedAt = Date.now();

    let result: ResultEnvelope;
    try {
      result = await this.deps.registry.sendCommand({
        deviceId,
        browserSessionHandle,
        tabId,
        command: entry.command,
        args: commandArgs,
        policyClass: entry.policyClass,
        timeoutMs,
        traceparent: caller.traceparent,
      });
    } catch (err) {
      const bridgeError = await this.describeIfDeviceOffline(BridgeError.from(err), requestedDeviceId, deviceId);
      const requestId =
        typeof bridgeError.details.requestId === 'string' ? bridgeError.details.requestId : null;
      await this.auditCommand(auditBase, entry.command, requestId, 'error', bridgeError.code, null);
      await this.audit({ ...auditBase, outcome: 'error', errorCode: bridgeError.code, requestId });
      this.logToolCall(auditBase, requestId, 'error', bridgeError.code, Date.now() - startedAt, null, {
        args,
        response: bridgeError.toPayload(),
      });
      throw bridgeError;
    }

    // §26: one linked command event per gateway-to-agent command (F-03).
    await this.auditCommand(
      auditBase,
      entry.command,
      result.requestId,
      result.status === 'ok' ? 'ok' : 'error',
      result.error?.code ?? null,
      result.durationMs,
    );

    if (result.status === 'error') {
      const error = result.error;
      const code = error !== null && isBridgeErrorCode(error.code) ? error.code : 'INTERNAL_ERROR';
      const bridgeError = new BridgeError(code, error?.message, (error?.details as Record<string, unknown>) ?? {});
      const outcome =
        bridgeError.code === 'ACTION_BLOCKED' || bridgeError.code === 'SECRET_FIELD_BLOCKED' ? 'denied' : 'error';
      await this.audit({ ...auditBase, outcome, errorCode: bridgeError.code, requestId: result.requestId });
      this.logToolCall(auditBase, result.requestId, outcome, bridgeError.code, Date.now() - startedAt, result.durationMs, {
        args,
        response: result.error,
      });
      throw bridgeError;
    }

    const structured = (result.result ?? {}) as Record<string, unknown>;

    // session_open: remember the handle→device mapping (§14) and persist it.
    if (toolName === 'browser_session_open' && typeof structured.browserSessionHandle === 'string') {
      const handle = structured.browserSessionHandle;
      this.deps.registry.rememberSessionOwner(handle, deviceId);
      const now = new Date();
      await this.deps.store.browserSessions.upsert({
        browserSessionHandle: handle,
        deviceId,
        profileName: String(structured.profileName ?? DEFAULT_PROFILE_NAME),
        status: structured.status === 'degraded' ? 'degraded' : 'ready',
        openedAt: now,
        lastSeenAt: now,
        closedAt: null,
      });
      structured.deviceId = deviceId;
    }

    const artifacts = await this.materializeArtifacts(result, caller.subject);

    await this.audit({ ...auditBase, outcome: 'ok', errorCode: null, requestId: result.requestId });
    // §26 counters/timers in structured logs (audit F-08).
    this.logToolCall(auditBase, result.requestId, 'ok', null, Date.now() - startedAt, result.durationMs, {
      args,
      response: structured,
    });
    return { structured, artifacts };
  }

  /**
   * A DEVICE_OFFLINE out of the registry says only that no OPEN socket
   * answered; the caller needs to know which PC that was, when it was last
   * seen and whether another one is up. The registry is store-free by
   * design, so the join happens here (devices/offline.ts). Every other
   * error passes through untouched, and a failing device lookup must not
   * mask the real error: the payload then carries what the registry alone
   * knows, and says so.
   */
  private async describeIfDeviceOffline(
    err: BridgeError,
    requestedDeviceId: string,
    targetDeviceId: string,
  ): Promise<BridgeError> {
    if (err.code !== 'DEVICE_OFFLINE') return err;
    // resolveDeviceId echoes an unresolvable "default" back unchanged, and
    // no paired device can be named "default" (ids are dev_…, §14).
    const resolvedDeviceId = targetDeviceId === 'default' ? null : targetDeviceId;
    try {
      const details = await describeDeviceOffline(
        { devices: this.deps.store.devices, registry: this.deps.registry },
        { requestedDeviceId, resolvedDeviceId },
      );
      return withDeviceOfflineDetails(err, details);
    } catch (lookupErr) {
      this.deps.logger.warn({ err: String(lookupErr) }, 'Paired-device lookup for DEVICE_OFFLINE details failed');
      return withDeviceOfflineDetails(err, {
        deviceId: requestedDeviceId,
        resolvedDeviceId,
        onlineDeviceIds: this.deps.registry.onlineDeviceIds(),
        knownDevices: [],
        hint: 'The paired-device records could not be read, so no last-seen time is available; check the gateway log and database.',
      });
    }
  }

  private logToolCall(
    base: { toolName: string; deviceId: string; browserSessionHandle: string; tabId: string | null },
    requestId: string | null,
    outcome: 'ok' | 'error' | 'denied',
    errorCode: string | null,
    durationMs: number,
    agentDurationMs: number | null,
    payload: { args: unknown; response: unknown },
  ): void {
    this.deps.callRecorder?.record({
      toolName: base.toolName,
      args: payload.args,
      response: payload.response,
      durationMs,
      outcome,
      errorCode,
      sessionId: base.browserSessionHandle,
      requestId,
    });
    this.deps.logger.info(
      {
        metric: 'tool_call',
        toolName: base.toolName,
        deviceId: base.deviceId,
        browserSessionHandle: base.browserSessionHandle,
        tabId: base.tabId,
        requestId,
        outcome,
        errorCode,
        durationMs,
        agentDurationMs,
      },
      'tool call completed',
    );
  }

  private async auditCommand(
    base: {
      userSubject: string | null;
      deviceId: string;
      browserSessionHandle: string;
      tabId: string | null;
      toolName: string;
      traceId: string | null;
    },
    command: string,
    requestId: string | null,
    outcome: 'ok' | 'error',
    errorCode: string | null,
    agentDurationMs: number | null,
  ): Promise<void> {
    try {
      await this.deps.store.audit.insert(
        buildAuditEvent({
          userSubject: base.userSubject,
          deviceId: base.deviceId,
          browserSessionHandle: base.browserSessionHandle,
          tabId: base.tabId,
          toolName: base.toolName,
          requestId,
          actionClass: 'command',
          outcome,
          errorCode,
          traceId: base.traceId,
          metadata: { command, agentDurationMs },
        }),
      );
    } catch (err) {
      this.deps.logger.error({ err: String(err) }, 'Command audit write failed');
    }
  }

  /** §16: inline ≤8 MiB as MCP image content; larger via signed URL. */
  private async materializeArtifacts(result: ResultEnvelope, subject: string | null): Promise<BrokerArtifactOut[]> {
    const out: BrokerArtifactOut[] = [];
    for (const artifact of result.artifacts as WireArtifact[]) {
      // Active-content MIME types never enter the artifact store (F-06).
      if (!isAllowedArtifactMime(artifact.mimeType)) {
        throw new BridgeError('DOWNLOAD_BLOCKED', `Artifact MIME type "${artifact.mimeType}" is not permitted.`, {
          artifactId: artifact.artifactId,
          mimeType: artifact.mimeType,
        });
      }
      if (artifact.transfer === 'inline' && artifact.dataBase64 !== null) {
        const bytes = Buffer.from(artifact.dataBase64, 'base64');
        const row = await this.deps.artifacts.put(artifact.artifactId, result.requestId, artifact.mimeType, bytes, subject);
        out.push({
          descriptor: {
            artifactId: artifact.artifactId,
            mimeType: artifact.mimeType,
            byteLength: bytes.length,
            delivery: 'mcp_inline',
            expiresAt: row.expiresAt.toISOString(),
          },
          inlineBase64: artifact.dataBase64,
          mimeType: artifact.mimeType,
          signedUrl: null,
        });
        continue;
      }
      // Uploaded out of band before the result arrived (§16 ordering).
      const stored = await this.deps.artifacts.get(artifact.artifactId);
      if (stored === null) {
        throw new BridgeError('ARTIFACT_EXPIRED', `Artifact ${artifact.artifactId} was not uploaded or already expired.`, {
          artifactId: artifact.artifactId,
        });
      }
      if (stored.row.byteLength <= MCP_INLINE_ARTIFACT_MAX_BYTES) {
        out.push({
          descriptor: {
            artifactId: artifact.artifactId,
            mimeType: stored.row.mimeType,
            byteLength: stored.row.byteLength,
            delivery: 'mcp_inline',
            expiresAt: stored.row.expiresAt.toISOString(),
          },
          inlineBase64: stored.bytes.toString('base64'),
          mimeType: stored.row.mimeType,
          signedUrl: null,
        });
      } else {
        out.push({
          descriptor: {
            artifactId: artifact.artifactId,
            mimeType: stored.row.mimeType,
            byteLength: stored.row.byteLength,
            delivery: 'signed_url',
            expiresAt: stored.row.expiresAt.toISOString(),
          },
          inlineBase64: null,
          mimeType: stored.row.mimeType,
          signedUrl: this.deps.artifacts.signedUrl(stored.row),
        });
      }
    }
    return out;
  }

  private async audit(input: {
    userSubject: string | null;
    deviceId: string;
    browserSessionHandle: string;
    tabId: string | null;
    toolName: string;
    actionClass: string;
    traceId: string | null;
    outcome: 'ok' | 'error' | 'denied';
    errorCode: string | null;
    requestId: string | null;
  }): Promise<void> {
    try {
      await this.deps.store.audit.insert(
        buildAuditEvent({
          userSubject: input.userSubject,
          deviceId: input.deviceId,
          browserSessionHandle: input.browserSessionHandle,
          tabId: input.tabId,
          toolName: input.toolName,
          requestId: input.requestId,
          actionClass: input.actionClass,
          outcome: input.outcome,
          errorCode: input.errorCode,
          traceId: input.traceId,
        }),
      );
    } catch (err) {
      this.deps.logger.error({ err: String(err) }, 'Audit write failed');
    }
  }
}
