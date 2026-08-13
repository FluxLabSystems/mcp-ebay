/**
 * Command broker — SDD v0.5 §15 (tool surface), §16 (artifacts), §18
 * (timeouts), §26 (audit). Maps MCP tool calls onto agent commands and
 * shapes results/artifacts for the MCP client.
 */
import { buildAuditEvent } from '@browser-bridge/audit';
import {
  BridgeError,
  BROWSER_SESSION_HANDLE_PATTERN,
  isBridgeErrorCode,
  MCP_INLINE_ARTIFACT_MAX_BYTES,
  PENDING_SESSION_HANDLE,
  getToolEntry,
  type ArtifactDescriptor,
  type ResultEnvelope,
  type WireArtifact,
} from '@browser-bridge/protocol';
import type { Logger } from 'pino';
import type { ArtifactStore } from './artifacts/store.js';
import type { DeviceRegistry } from './devices/registry.js';
import type { Store } from './store/types.js';

export interface BrokerDeps {
  registry: DeviceRegistry;
  store: Store;
  artifacts: ArtifactStore;
  logger: Logger;
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

    let deviceId: string;
    let browserSessionHandle: string;
    let tabId: string | null = null;
    const commandArgs: Record<string, unknown> = { ...args };

    if (toolName === 'browser.session_open') {
      deviceId = this.deps.registry.resolveDeviceId(String(args.deviceId ?? ''));
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
      deviceId = owner;
      delete commandArgs.browserSessionHandle;
      if ('tabId' in commandArgs) {
        tabId = String(commandArgs.tabId);
        delete commandArgs.tabId;
      }
    }

    // browser.handoff carries a user-configured wait; extend the deadline.
    const timeoutMs =
      toolName === 'browser.handoff'
        ? (Number(args.timeoutSeconds ?? 300) + 30) * 1000
        : entry.timeoutMs;

    const auditBase = {
      userSubject: caller.subject,
      deviceId,
      browserSessionHandle,
      tabId,
      toolName,
      actionClass: entry.policyClass,
      traceId: caller.traceparent,
    };

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
      const bridgeError = BridgeError.from(err);
      await this.audit({ ...auditBase, outcome: 'error', errorCode: bridgeError.code, requestId: null });
      throw bridgeError;
    }

    if (result.status === 'error') {
      const error = result.error;
      const code = error !== null && isBridgeErrorCode(error.code) ? error.code : 'INTERNAL_ERROR';
      const bridgeError = new BridgeError(code, error?.message, (error?.details as Record<string, unknown>) ?? {});
      await this.audit({
        ...auditBase,
        outcome: bridgeError.code === 'ACTION_BLOCKED' || bridgeError.code === 'SECRET_FIELD_BLOCKED' ? 'denied' : 'error',
        errorCode: bridgeError.code,
        requestId: result.requestId,
      });
      throw bridgeError;
    }

    const structured = (result.result ?? {}) as Record<string, unknown>;

    // session_open: remember the handle→device mapping (§14) and persist it.
    if (toolName === 'browser.session_open' && typeof structured.browserSessionHandle === 'string') {
      const handle = structured.browserSessionHandle;
      this.deps.registry.rememberSessionOwner(handle, deviceId);
      const now = new Date();
      await this.deps.store.browserSessions.upsert({
        browserSessionHandle: handle,
        deviceId,
        profileName: String(structured.profileName ?? 'ebay-research'),
        status: structured.status === 'degraded' ? 'degraded' : 'ready',
        openedAt: now,
        lastSeenAt: now,
        closedAt: null,
      });
      structured.deviceId = deviceId;
    }

    const artifacts = await this.materializeArtifacts(result, caller.subject);

    await this.audit({ ...auditBase, outcome: 'ok', errorCode: null, requestId: result.requestId });
    return { structured, artifacts };
  }

  /** §16: inline ≤8 MiB as MCP image content; larger via signed URL. */
  private async materializeArtifacts(result: ResultEnvelope, subject: string | null): Promise<BrokerArtifactOut[]> {
    const out: BrokerArtifactOut[] = [];
    for (const artifact of result.artifacts as WireArtifact[]) {
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
