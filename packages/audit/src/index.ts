/**
 * Audit event model — SDD v0.5 §21 (audit_events table) and §26. Every MCP
 * tools/call produces one gateway audit event; every gateway-to-agent
 * command produces one linked command event. Secrets never appear in
 * events or logs.
 */
import { newEventId } from '@browser-bridge/protocol';

export type AuditOutcome = 'ok' | 'error' | 'denied';

export interface AuditEvent {
  eventId: string;
  observedAt: string;
  userSubject: string | null;
  deviceId: string | null;
  browserSessionHandle: string | null;
  tabId: string | null;
  toolName: string | null;
  requestId: string | null;
  actionClass: string;
  outcome: AuditOutcome;
  errorCode: string | null;
  traceId: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

export interface AuditEventInput {
  userSubject?: string | null;
  deviceId?: string | null;
  browserSessionHandle?: string | null;
  tabId?: string | null;
  toolName?: string | null;
  requestId?: string | null;
  actionClass: string;
  outcome: AuditOutcome;
  errorCode?: string | null;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Keys that must never survive into audit metadata or structured logs
 * (§26): secret values, cookies, auth headers, pairing tokens, keys,
 * screenshot payloads.
 */
const REDACTED_KEY_FRAGMENTS = [
  'password',
  'cookie',
  'authorization',
  'token',
  'secret',
  'private_key',
  'privatekey',
  'set-cookie',
  'data_base64',
  'databases64',
  'databaseurl',
];

const REDACTED_SAFE_KEYS = new Set(['idempotencykey', 'artifacttokenexpiresat']);

export function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const sensitive =
      !REDACTED_SAFE_KEYS.has(lower) && REDACTED_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment.replace(/[^a-z0-9]/g, '')));
    if (sensitive) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = redactMetadata(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function buildAuditEvent(input: AuditEventInput, now: Date = new Date()): AuditEvent {
  return {
    eventId: newEventId(),
    observedAt: now.toISOString(),
    userSubject: input.userSubject ?? null,
    deviceId: input.deviceId ?? null,
    browserSessionHandle: input.browserSessionHandle ?? null,
    tabId: input.tabId ?? null,
    toolName: input.toolName ?? null,
    requestId: input.requestId ?? null,
    actionClass: input.actionClass,
    outcome: input.outcome,
    errorCode: input.errorCode ?? null,
    traceId: input.traceId ?? null,
    metadata: redactMetadata(input.metadata ?? {}),
  };
}

/** In-memory sink for tests and development. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  record(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
