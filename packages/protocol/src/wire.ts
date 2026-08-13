/**
 * Gateway–agent wire protocol — SDD v0.5 §12 and Appendix B. All JSON
 * messages carry protocolVersion "1.0" and a top-level type. Unknown major
 * versions are rejected by the gateway.
 */
import * as z from 'zod/v4';
import { BRIDGE_ERROR_CODES } from './errors.js';

export const WIRE_PROTOCOL_VERSION = '1.0';

export const PolicyClassSchema = z.enum(['read', 'reversible', 'control']);

/** Appendix B command.schema.json. */
export const CommandEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
  type: z.literal('command'),
  requestId: z.string(),
  deviceId: z.string(),
  browserSessionHandle: z.string(),
  tabId: z.union([z.string(), z.null()]),
  command: z.string(),
  arguments: z.looseObject({}),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z.string(),
  policyClass: PolicyClassSchema,
  traceparent: z.union([z.string(), z.null()]),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const WireErrorSchema = z.strictObject({
  code: z.enum(BRIDGE_ERROR_CODES as [string, ...string[]]),
  message: z.string(),
  retryable: z.boolean(),
  details: z.looseObject({}),
});
export type WireError = z.infer<typeof WireErrorSchema>;

/** Inline artifact carried inside a result message (≤ 1 MiB, §12). */
export const WireArtifactSchema = z.strictObject({
  artifactId: z.string(),
  mimeType: z.string(),
  byteLength: z.int(),
  /** base64 payload when delivered inline; null when uploaded out of band. */
  dataBase64: z.union([z.string(), z.null()]),
  /** 'inline' | 'uploaded' transfer marker. */
  transfer: z.enum(['inline', 'uploaded']),
});
export type WireArtifact = z.infer<typeof WireArtifactSchema>;

/** Appendix B result.schema.json. */
export const ResultEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
  type: z.literal('result'),
  requestId: z.string(),
  status: z.enum(['ok', 'error']),
  pageRevision: z.union([z.int(), z.null()]),
  result: z.union([z.looseObject({}), z.null()]),
  artifacts: z.array(WireArtifactSchema),
  error: z.union([WireErrorSchema, z.null()]),
  durationMs: z.int(),
});
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Control messages (§12.4)
// ---------------------------------------------------------------------------

export const DeviceChallengeSchema = z.strictObject({
  protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
  type: z.literal('device.challenge'),
  nonce: z.string(),
  issuedAt: z.iso.datetime({ offset: true }),
});
export type DeviceChallenge = z.infer<typeof DeviceChallengeSchema>;

export const DeviceHelloSchema = z.strictObject({
  protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
  type: z.literal('device.hello'),
  deviceId: z.string(),
  publicKeyFingerprint: z.string(),
  signature: z.string(),
  timestamp: z.iso.datetime({ offset: true }),
  agentVersion: z.string(),
});
export type DeviceHello = z.infer<typeof DeviceHelloSchema>;

export const DeviceReadySchema = z.strictObject({
  protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
  type: z.literal('device.ready'),
  connectionId: z.string(),
  artifactToken: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type DeviceReady = z.infer<typeof DeviceReadySchema>;

export const HeartbeatSchema = z.strictObject({
  protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
  type: z.literal('heartbeat'),
  timestamp: z.iso.datetime({ offset: true }),
  connectionId: z.string(),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const AckSchema = z.strictObject({
  protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
  type: z.literal('ack'),
  requestId: z.string(),
  acceptedAt: z.iso.datetime({ offset: true }),
});
export type Ack = z.infer<typeof AckSchema>;

export const CancelSchema = z.strictObject({
  protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
  type: z.literal('cancel'),
  requestId: z.string(),
  reason: z.string(),
});
export type Cancel = z.infer<typeof CancelSchema>;

/**
 * Reconnect state report (§12.5): after re-authentication the agent reports
 * active application browser sessions and tabs so the gateway can reconcile
 * handle→device state.
 */
export const StateReportSchema = z.strictObject({
  protocolVersion: z.literal(WIRE_PROTOCOL_VERSION),
  type: z.literal('state.report'),
  sessions: z.array(
    z.strictObject({
      browserSessionHandle: z.string(),
      profileName: z.string(),
      status: z.enum(['ready', 'degraded']),
      tabs: z.array(
        z.strictObject({
          tabId: z.string(),
          url: z.string(),
          title: z.string(),
          active: z.boolean(),
          pageRevision: z.int(),
        }),
      ),
    }),
  ),
});
export type StateReport = z.infer<typeof StateReportSchema>;

/** Every message the gateway may receive from an agent. */
export const AgentToGatewayMessageSchema = z.discriminatedUnion('type', [
  DeviceHelloSchema,
  HeartbeatSchema,
  AckSchema,
  ResultEnvelopeSchema,
  StateReportSchema,
]);
export type AgentToGatewayMessage = z.infer<typeof AgentToGatewayMessageSchema>;

/** Every message an agent may receive from the gateway. */
export const GatewayToAgentMessageSchema = z.discriminatedUnion('type', [
  DeviceChallengeSchema,
  DeviceReadySchema,
  HeartbeatSchema,
  CommandEnvelopeSchema,
  CancelSchema,
]);
export type GatewayToAgentMessage = z.infer<typeof GatewayToAgentMessageSchema>;

/**
 * Parse a raw wire frame. Rejects unknown major protocol versions before
 * shape validation so version mismatch yields a stable, specific failure.
 */
export function parseWireMessage<T>(raw: string, schema: z.ZodType<T>): T {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'protocolVersion' in parsed &&
    typeof (parsed as { protocolVersion: unknown }).protocolVersion === 'string'
  ) {
    const version = (parsed as { protocolVersion: string }).protocolVersion;
    const major = version.split('.')[0];
    if (major !== WIRE_PROTOCOL_VERSION.split('.')[0]) {
      throw new Error(`Unsupported wire protocol major version: ${version}`);
    }
  }
  return schema.parse(parsed);
}
