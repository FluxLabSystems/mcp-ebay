/**
 * In-memory Store for tests and local development. Mirrors the PostgreSQL
 * semantics in §21 (single-use pairing tokens, revocation, TTL cleanup).
 */
import type { AuditEvent } from '@browser-bridge/audit';
import type {
  ArtifactMetaStore,
  ArtifactRow,
  AuditStore,
  BrowserSessionRow,
  BrowserSessionStore,
  DeviceRow,
  DeviceStore,
  PairingTokenStore,
  RunCheckpointRow,
  RunCheckpointStore,
  Store,
} from './types.js';

class MemoryDevices implements DeviceStore {
  readonly rows = new Map<string, DeviceRow>();

  insert(device: DeviceRow): Promise<void> {
    this.rows.set(device.deviceId, { ...device });
    return Promise.resolve();
  }
  get(deviceId: string): Promise<DeviceRow | null> {
    const row = this.rows.get(deviceId);
    return Promise.resolve(row === undefined ? null : { ...row });
  }
  list(): Promise<DeviceRow[]> {
    return Promise.resolve([...this.rows.values()].map((row) => ({ ...row })));
  }
  setStatus(deviceId: string, status: 'active' | 'revoked'): Promise<boolean> {
    const row = this.rows.get(deviceId);
    if (row === undefined) return Promise.resolve(false);
    row.status = status;
    return Promise.resolve(true);
  }
  touchLastSeen(deviceId: string, at: Date, agentVersion?: string): Promise<void> {
    const row = this.rows.get(deviceId);
    if (row !== undefined) {
      row.lastSeenAt = at;
      if (agentVersion !== undefined) row.agentVersion = agentVersion;
    }
    return Promise.resolve();
  }
}

interface TokenRow {
  tokenHashHex: string;
  requestedName: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

class MemoryPairingTokens implements PairingTokenStore {
  readonly rows = new Map<string, TokenRow>();

  insert(tokenHash: Buffer, requestedName: string | null, expiresAt: Date): Promise<void> {
    this.rows.set(tokenHash.toString('hex'), {
      tokenHashHex: tokenHash.toString('hex'),
      requestedName,
      expiresAt,
      consumedAt: null,
    });
    return Promise.resolve();
  }
  consume(tokenHash: Buffer, now: Date): Promise<{ requestedName: string | null } | null> {
    const row = this.rows.get(tokenHash.toString('hex'));
    if (row === undefined || row.consumedAt !== null || row.expiresAt.getTime() <= now.getTime()) {
      return Promise.resolve(null);
    }
    row.consumedAt = now;
    return Promise.resolve({ requestedName: row.requestedName });
  }
  purgeExpired(now: Date): Promise<number> {
    let purged = 0;
    for (const [key, row] of this.rows) {
      if (row.expiresAt.getTime() <= now.getTime()) {
        this.rows.delete(key);
        purged += 1;
      }
    }
    return Promise.resolve(purged);
  }
}

class MemoryBrowserSessions implements BrowserSessionStore {
  readonly rows = new Map<string, BrowserSessionRow>();

  upsert(row: BrowserSessionRow): Promise<void> {
    // Mirror the PG ON CONFLICT semantics: openedAt is preserved on
    // conflict; only status/lastSeenAt/closedAt update (audit F-14).
    const existing = this.rows.get(row.browserSessionHandle);
    this.rows.set(row.browserSessionHandle, {
      ...row,
      openedAt: existing?.openedAt ?? row.openedAt,
    });
    return Promise.resolve();
  }
  get(handle: string): Promise<BrowserSessionRow | null> {
    const row = this.rows.get(handle);
    return Promise.resolve(row === undefined ? null : { ...row });
  }
  markClosedForDevice(deviceId: string, at: Date): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.deviceId === deviceId && row.status !== 'closed') {
        row.status = 'closed';
        row.closedAt = at;
      }
    }
    return Promise.resolve();
  }
}

class MemoryArtifacts implements ArtifactMetaStore {
  readonly rows = new Map<string, ArtifactRow>();

  insert(row: ArtifactRow): Promise<void> {
    this.rows.set(row.artifactId, { ...row });
    return Promise.resolve();
  }
  get(artifactId: string): Promise<ArtifactRow | null> {
    const row = this.rows.get(artifactId);
    return Promise.resolve(row === undefined ? null : { ...row });
  }
  listExpired(now: Date): Promise<ArtifactRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((row) => row.expiresAt.getTime() <= now.getTime()).map((row) => ({ ...row })),
    );
  }
  delete(artifactId: string): Promise<void> {
    this.rows.delete(artifactId);
    return Promise.resolve();
  }
  aggregateBytesForRequest(requestId: string): Promise<number> {
    let total = 0;
    for (const row of this.rows.values()) {
      if (row.requestId === requestId) total += row.byteLength;
    }
    return Promise.resolve(total);
  }
}

class MemoryAudit implements AuditStore {
  readonly events: AuditEvent[] = [];
  insert(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

function cloneRun(row: RunCheckpointRow): RunCheckpointRow {
  return { ...row, searched: [...row.searched], verifiedIds: [...row.verifiedIds], pendingIds: [...row.pendingIds] };
}

class MemoryRunCheckpoints implements RunCheckpointStore {
  readonly rows = new Map<string, RunCheckpointRow>();

  put(row: RunCheckpointRow): Promise<void> {
    this.rows.set(row.runId, cloneRun(row));
    return Promise.resolve();
  }
  get(runId: string, now: Date): Promise<RunCheckpointRow | null> {
    const row = this.rows.get(runId);
    // Mirror the PG predicate rather than the sweeper: an expired row is
    // gone from a reader's point of view the moment it expires, not when
    // the next cleanup tick happens to run.
    if (row === undefined || row.expiresAt.getTime() <= now.getTime()) return Promise.resolve(null);
    return Promise.resolve(cloneRun(row));
  }
  latestResumable(dashboard: string, ownerSubject: string | null, now: Date): Promise<RunCheckpointRow | null> {
    let best: RunCheckpointRow | null = null;
    for (const row of this.rows.values()) {
      if (row.dashboard !== dashboard) continue;
      if (row.ownerSubject !== ownerSubject) continue;
      if (row.status !== 'running') continue;
      if (row.expiresAt.getTime() <= now.getTime()) continue;
      if (best === null || row.updatedAt.getTime() > best.updatedAt.getTime()) best = row;
    }
    return Promise.resolve(best === null ? null : cloneRun(best));
  }
  purgeExpired(now: Date): Promise<number> {
    let purged = 0;
    for (const [key, row] of this.rows) {
      if (row.expiresAt.getTime() <= now.getTime()) {
        this.rows.delete(key);
        purged += 1;
      }
    }
    return Promise.resolve(purged);
  }
}

export class MemoryStore implements Store {
  readonly devices = new MemoryDevices();
  readonly pairingTokens = new MemoryPairingTokens();
  readonly browserSessions = new MemoryBrowserSessions();
  readonly artifacts = new MemoryArtifacts();
  readonly audit = new MemoryAudit();
  readonly runCheckpoints = new MemoryRunCheckpoints();

  ready(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
