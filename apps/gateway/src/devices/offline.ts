/**
 * What a DEVICE_OFFLINE error is able to say — which PC is down, when it
 * was last seen, and whether another one is up. The registry knows only
 * live sockets and the store only paired rows; the broker joins the two
 * here so the registry stays store-free. Motivated by the deals routine's
 * 2026-09-03T07:13Z fire: the MCP surface has no device-listing tool, so a
 * run could not tell "the one PC is down" from "the wrong id was passed".
 */
import { BridgeError } from '@browser-bridge/protocol';
import type { DeviceRow, DeviceStore } from '../store/types.js';
import type { DeviceLiveness, DeviceRegistry } from './registry.js';

/** Cap on knownDevices in an error payload; a homelab pairs a handful. */
export const KNOWN_DEVICES_LIMIT = 10;

export interface KnownDeviceSummary {
  deviceId: string;
  name: string;
  status: DeviceRow['status'];
  /**
   * Persisted devices.last_seen_at as ISO 8601 — stamped at hello, on
   * every agent heartbeat and on disconnect (devices/wsHandler.ts); null
   * when the device has never connected since pairing.
   */
  lastSeenAt: string | null;
  /** Registered with an OPEN socket when the error was raised. */
  online: boolean;
  /**
   * The live socket's view (2026-09-14): the last frame the gateway received
   * from the agent on its current connection, and how long ago that was.
   * Null when the device is not registered. This is what separates a
   * connected-but-silent agent (AGENT_UNRESPONSIVE) from an absent one —
   * the persisted lastSeenAt above moves on heartbeats only and froze for
   * two minutes while the socket stayed OPEN.
   */
  lastFrameAt: string | null;
  silentForMs: number | null;
}

/** `details` of every DEVICE_OFFLINE and AGENT_UNRESPONSIVE the broker raises (protocol errors.ts). */
export interface DeviceOfflineDetails {
  /** deviceId exactly as the caller passed it — the literal "default" included. */
  deviceId: string;
  /** Device the gateway targeted; null when "default" resolved to nothing. */
  resolvedDeviceId: string | null;
  /** Devices that could take a command when the error was raised. */
  onlineDeviceIds: string[];
  /** Paired devices, most recently seen first, at most KNOWN_DEVICES_LIMIT. */
  knownDevices: KnownDeviceSummary[];
  /** One sentence a routine can quote in its report as-is. */
  hint: string;
}

export interface DeviceOfflineTarget {
  requestedDeviceId: string;
  resolvedDeviceId: string | null;
}

/** Most recently seen first; never-seen rows after those, newest pairing first. */
function bySeenDesc(a: DeviceRow, b: DeviceRow): number {
  const seenA = a.lastSeenAt?.getTime() ?? -1;
  const seenB = b.lastSeenAt?.getTime() ?? -1;
  if (seenA !== seenB) return seenB - seenA;
  return b.pairedAt.getTime() - a.pairedAt.getTime();
}

/**
 * Shape the persisted rows for the payload. Ordering and the cap live here
 * rather than in the stores so the in-memory and PostgreSQL
 * implementations cannot disagree on them.
 */
export function summarizeKnownDevices(
  rows: readonly DeviceRow[],
  onlineDeviceIds: readonly string[],
  liveness: ReadonlyMap<string, DeviceLiveness> = new Map(),
): KnownDeviceSummary[] {
  const online = new Set(onlineDeviceIds);
  return [...rows]
    .sort(bySeenDesc)
    .slice(0, KNOWN_DEVICES_LIMIT)
    .map((row) => {
      const live = liveness.get(row.deviceId);
      return {
        deviceId: row.deviceId,
        name: row.name,
        status: row.status,
        lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.toISOString(),
        online: online.has(row.deviceId),
        lastFrameAt: live?.lastFrameAt ?? null,
        silentForMs: live?.silentForMs ?? null,
      };
    });
}

function seenClause(device: KnownDeviceSummary): string {
  return device.lastSeenAt === null ? 'has never connected since pairing' : `was last seen ${device.lastSeenAt}`;
}

/** One sentence answering "which PC, and is another one available?". */
export function deviceOfflineHint(details: Omit<DeviceOfflineDetails, 'hint'>): string {
  const { resolvedDeviceId: resolved, onlineDeviceIds: online, knownDevices: known } = details;
  const byId = new Map(known.map((device) => [device.deviceId, device]));
  const named = (id: string): string => {
    const device = byId.get(id);
    return device === undefined ? id : `${device.name} (${id})`;
  };
  const target = resolved === null ? undefined : byId.get(resolved);

  // The socket was OPEN and still nothing came back — no ack within the
  // window, a failed send, or a drop mid-command — not an absent device.
  // Say how long the socket has been silent when the registry knows: two
  // minutes of silence is a stalled agent, two seconds is a slow one.
  if (resolved !== null && online.includes(resolved)) {
    if (target?.silentForMs != null && target.lastFrameAt !== null) {
      const seconds = Math.round(target.silentForMs / 1000);
      return `${named(resolved)} is connected but did not answer the command; its last frame reached the gateway ${seconds} s ago (${target.lastFrameAt}). Retry after a pause, and check the agent console if it persists.`;
    }
    return `${named(resolved)} is connected but did not answer the command; retry, and check the agent console if it persists.`;
  }

  if (online.length === 0) {
    if (known.length === 0) {
      return 'No Windows agent is connected and no device has been paired; pair one with device:pair on the gateway.';
    }
    // The device the caller should hear about: the one it asked for when
    // that is a paired device, else the most recently seen active one (a
    // revoked device cannot come back, so it is only the last resort).
    const subject = target ?? known.find((device) => device.status === 'active') ?? known[0]!;
    if (resolved !== null && target === undefined) {
      return `No Windows agent is connected, and deviceId "${resolved}" is not a paired device; ${named(subject.deviceId)} ${seenClause(subject)}.`;
    }
    const revoked = subject.status === 'revoked' ? ' and is revoked' : '';
    return `No Windows agent is connected; ${named(subject.deviceId)} ${seenClause(subject)}${revoked}.`;
  }

  // Something is online, just not what was asked for.
  const connected = online.map(named).join(', ');
  if (resolved === null) {
    const count = `${online.length} agent${online.length === 1 ? '' : 's'}`;
    return `deviceId "default" did not resolve with ${count} connected (${connected}); pass one of those ids explicitly.`;
  }
  if (target === undefined) {
    return `deviceId "${resolved}" is not a paired device; connected: ${connected}.`;
  }
  const revoked = target.status === 'revoked' ? ' and is revoked' : '';
  return `${named(resolved)} is not connected (${seenClause(target)}${revoked}); connected: ${connected}.`;
}

/** Join the live registry with the persisted device rows for one error. */
export async function describeDeviceOffline(
  deps: { devices: Pick<DeviceStore, 'list'>; registry: Pick<DeviceRegistry, 'onlineDeviceIds' | 'liveness'> },
  target: DeviceOfflineTarget,
): Promise<DeviceOfflineDetails> {
  const onlineDeviceIds = deps.registry.onlineDeviceIds();
  const rows = await deps.devices.list();
  const liveness = new Map<string, DeviceLiveness>();
  for (const row of rows) {
    const live = deps.registry.liveness(row.deviceId);
    if (live !== null) liveness.set(row.deviceId, live);
  }
  const facts = {
    deviceId: target.requestedDeviceId,
    resolvedDeviceId: target.resolvedDeviceId,
    onlineDeviceIds,
    knownDevices: summarizeKnownDevices(rows, onlineDeviceIds, liveness),
  };
  return { ...facts, hint: deviceOfflineHint(facts) };
}

/**
 * Same code, retryability and base message; the hint is appended to the
 * message so a caller that only reads `message` still learns which PC is
 * down (or silent), and whatever the registry attached (requestId,
 * ackTimeoutMs, lastFrameAt and silentForMs on an AGENT_UNRESPONSIVE)
 * survives underneath the new fields.
 */
export function withDeviceOfflineDetails(err: BridgeError, details: DeviceOfflineDetails): BridgeError {
  const message = err.message.endsWith(details.hint) ? err.message : `${err.message} ${details.hint}`;
  return new BridgeError(err.code, message, { ...err.details, ...details });
}
