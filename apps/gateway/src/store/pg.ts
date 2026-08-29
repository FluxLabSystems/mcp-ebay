/**
 * PostgreSQL Store — SDD v0.5 §21. Schema lives in db/migrations; this
 * layer only reads/writes the normative tables.
 */
import pg from 'pg';
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

const { Pool } = pg;

class PgDevices implements DeviceStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(device: DeviceRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO devices (device_id, name, public_key_ed25519, key_fingerprint, status, agent_version, paired_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        device.deviceId,
        device.name,
        device.publicKeyEd25519,
        device.keyFingerprint,
        device.status,
        device.agentVersion,
        device.pairedAt,
        device.lastSeenAt,
      ],
    );
  }

  async get(deviceId: string): Promise<DeviceRow | null> {
    const result = await this.pool.query(
      `SELECT device_id, name, public_key_ed25519, key_fingerprint, status, agent_version, paired_at, last_seen_at
       FROM devices WHERE device_id = $1`,
      [deviceId],
    );
    const row = result.rows[0] as
      | {
          device_id: string;
          name: string;
          public_key_ed25519: Buffer;
          key_fingerprint: string;
          status: 'active' | 'revoked';
          agent_version: string | null;
          paired_at: Date;
          last_seen_at: Date | null;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      deviceId: row.device_id,
      name: row.name,
      publicKeyEd25519: row.public_key_ed25519,
      keyFingerprint: row.key_fingerprint,
      status: row.status,
      agentVersion: row.agent_version,
      pairedAt: row.paired_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  async list(): Promise<DeviceRow[]> {
    const result = await this.pool.query(
      `SELECT device_id, name, public_key_ed25519, key_fingerprint, status, agent_version, paired_at, last_seen_at
       FROM devices ORDER BY paired_at`,
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      deviceId: row.device_id as string,
      name: row.name as string,
      publicKeyEd25519: row.public_key_ed25519 as Buffer,
      keyFingerprint: row.key_fingerprint as string,
      status: row.status as 'active' | 'revoked',
      agentVersion: row.agent_version as string | null,
      pairedAt: row.paired_at as Date,
      lastSeenAt: row.last_seen_at as Date | null,
    }));
  }

  async setStatus(deviceId: string, status: 'active' | 'revoked'): Promise<boolean> {
    const result = await this.pool.query(`UPDATE devices SET status = $2 WHERE device_id = $1`, [deviceId, status]);
    return (result.rowCount ?? 0) > 0;
  }

  async touchLastSeen(deviceId: string, at: Date, agentVersion?: string): Promise<void> {
    if (agentVersion !== undefined) {
      await this.pool.query(`UPDATE devices SET last_seen_at = $2, agent_version = $3 WHERE device_id = $1`, [
        deviceId,
        at,
        agentVersion,
      ]);
    } else {
      await this.pool.query(`UPDATE devices SET last_seen_at = $2 WHERE device_id = $1`, [deviceId, at]);
    }
  }
}

class PgPairingTokens implements PairingTokenStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(tokenHash: Buffer, requestedName: string | null, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_pairing_tokens (token_hash, requested_name, expires_at) VALUES ($1, $2, $3)`,
      [tokenHash, requestedName, expiresAt],
    );
  }

  async consume(tokenHash: Buffer, now: Date): Promise<{ requestedName: string | null } | null> {
    const result = await this.pool.query(
      `UPDATE device_pairing_tokens
       SET consumed_at = $2
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
       RETURNING requested_name`,
      [tokenHash, now],
    );
    const row = result.rows[0] as { requested_name: string | null } | undefined;
    return row === undefined ? null : { requestedName: row.requested_name };
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.pool.query(`DELETE FROM device_pairing_tokens WHERE expires_at <= $1`, [now]);
    return result.rowCount ?? 0;
  }
}

class PgBrowserSessions implements BrowserSessionStore {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(row: BrowserSessionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO browser_sessions (browser_session_handle, device_id, profile_name, status, opened_at, last_seen_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (browser_session_handle)
       DO UPDATE SET status = EXCLUDED.status, last_seen_at = EXCLUDED.last_seen_at, closed_at = EXCLUDED.closed_at`,
      [row.browserSessionHandle, row.deviceId, row.profileName, row.status, row.openedAt, row.lastSeenAt, row.closedAt],
    );
  }

  async get(handle: string): Promise<BrowserSessionRow | null> {
    const result = await this.pool.query(
      `SELECT browser_session_handle, device_id, profile_name, status, opened_at, last_seen_at, closed_at
       FROM browser_sessions WHERE browser_session_handle = $1`,
      [handle],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      browserSessionHandle: row.browser_session_handle as string,
      deviceId: row.device_id as string,
      profileName: row.profile_name as string,
      status: row.status as BrowserSessionRow['status'],
      openedAt: row.opened_at as Date,
      lastSeenAt: row.last_seen_at as Date,
      closedAt: row.closed_at as Date | null,
    };
  }

  async markClosedForDevice(deviceId: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE browser_sessions SET status = 'closed', closed_at = $2 WHERE device_id = $1 AND status <> 'closed'`,
      [deviceId, at],
    );
  }
}

class PgArtifacts implements ArtifactMetaStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(row: ArtifactRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO artifacts (artifact_id, request_id, owner_subject, mime_type, byte_length, storage_path, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.artifactId, row.requestId, row.ownerSubject, row.mimeType, row.byteLength, row.storagePath, row.createdAt, row.expiresAt],
    );
  }

  async get(artifactId: string): Promise<ArtifactRow | null> {
    const result = await this.pool.query(
      `SELECT artifact_id, request_id, owner_subject, mime_type, byte_length, storage_path, created_at, expires_at
       FROM artifacts WHERE artifact_id = $1`,
      [artifactId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      artifactId: row.artifact_id as string,
      requestId: row.request_id as string,
      ownerSubject: row.owner_subject as string | null,
      mimeType: row.mime_type as string,
      byteLength: Number(row.byte_length),
      storagePath: row.storage_path as string,
      createdAt: row.created_at as Date,
      expiresAt: row.expires_at as Date,
    };
  }

  async listExpired(now: Date): Promise<ArtifactRow[]> {
    const result = await this.pool.query(`SELECT artifact_id, request_id, owner_subject, mime_type, byte_length, storage_path, created_at, expires_at FROM artifacts WHERE expires_at <= $1`, [now]);
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      artifactId: row.artifact_id as string,
      requestId: row.request_id as string,
      ownerSubject: row.owner_subject as string | null,
      mimeType: row.mime_type as string,
      byteLength: Number(row.byte_length),
      storagePath: row.storage_path as string,
      createdAt: row.created_at as Date,
      expiresAt: row.expires_at as Date,
    }));
  }

  async delete(artifactId: string): Promise<void> {
    await this.pool.query(`DELETE FROM artifacts WHERE artifact_id = $1`, [artifactId]);
  }

  async aggregateBytesForRequest(requestId: string): Promise<number> {
    const result = await this.pool.query(`SELECT COALESCE(SUM(byte_length), 0) AS total FROM artifacts WHERE request_id = $1`, [requestId]);
    return Number((result.rows[0] as { total: string | number }).total);
  }
}

class PgAudit implements AuditStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (event_id, observed_at, user_subject, device_id, browser_session_handle, tab_id, tool_name, request_id, action_class, outcome, error_code, trace_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        event.eventId,
        event.observedAt,
        event.userSubject,
        event.deviceId,
        event.browserSessionHandle,
        event.tabId,
        event.toolName,
        event.requestId,
        event.actionClass,
        event.outcome,
        event.errorCode,
        event.traceId,
        JSON.stringify(event.metadata),
      ],
    );
  }
}

/** jsonb text[] columns come back as arrays already; guard the shape anyway. */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function toRunRow(row: Record<string, unknown>): RunCheckpointRow {
  return {
    runId: row.run_id as string,
    dashboard: row.dashboard as string,
    ownerSubject: row.owner_subject as string | null,
    status: row.status as RunCheckpointRow['status'],
    searched: toStringArray(row.searched),
    verifiedIds: toStringArray(row.verified_ids),
    pendingIds: toStringArray(row.pending_ids),
    notes: row.notes as string | null,
    checkpointCount: Number(row.checkpoint_count),
    startedAt: row.started_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: row.expires_at as Date,
  };
}

const RUN_COLUMNS =
  'run_id, dashboard, owner_subject, status, searched, verified_ids, pending_ids, notes, checkpoint_count, started_at, updated_at, expires_at';

class PgRunCheckpoints implements RunCheckpointStore {
  constructor(private readonly pool: pg.Pool) {}

  async put(row: RunCheckpointRow): Promise<void> {
    // Every column takes EXCLUDED, started_at included. The service reads
    // the run first and hands down the authoritative started_at — the
    // existing one for a continuing run, `now` for a new run reusing the id
    // of an expired one. Preserving started_at here instead would make this
    // layer disagree with the in-memory store, whose put replaces the row
    // wholesale, on exactly the case the read predicate calls absent.
    await this.pool.query(
      `INSERT INTO run_checkpoints (${RUN_COLUMNS})
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)
       ON CONFLICT (run_id)
       DO UPDATE SET dashboard = EXCLUDED.dashboard,
                     owner_subject = EXCLUDED.owner_subject,
                     status = EXCLUDED.status,
                     searched = EXCLUDED.searched,
                     verified_ids = EXCLUDED.verified_ids,
                     pending_ids = EXCLUDED.pending_ids,
                     notes = EXCLUDED.notes,
                     checkpoint_count = EXCLUDED.checkpoint_count,
                     started_at = EXCLUDED.started_at,
                     updated_at = EXCLUDED.updated_at,
                     expires_at = EXCLUDED.expires_at`,
      [
        row.runId,
        row.dashboard,
        row.ownerSubject,
        row.status,
        JSON.stringify(row.searched),
        JSON.stringify(row.verifiedIds),
        JSON.stringify(row.pendingIds),
        row.notes,
        row.checkpointCount,
        row.startedAt,
        row.updatedAt,
        row.expiresAt,
      ],
    );
  }

  async get(runId: string, now: Date): Promise<RunCheckpointRow | null> {
    const result = await this.pool.query(
      `SELECT ${RUN_COLUMNS} FROM run_checkpoints WHERE run_id = $1 AND expires_at > $2`,
      [runId, now],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toRunRow(row);
  }

  async latestResumable(dashboard: string, ownerSubject: string | null, now: Date): Promise<RunCheckpointRow | null> {
    // `owner_subject IS NOT DISTINCT FROM $2` rather than `=`: an
    // OAuth-disabled deployment stores null owners, and null = null is not
    // true in SQL, so `=` would make every such run unresumable.
    const result = await this.pool.query(
      `SELECT ${RUN_COLUMNS} FROM run_checkpoints
       WHERE dashboard = $1 AND owner_subject IS NOT DISTINCT FROM $2 AND status = 'running' AND expires_at > $3
       ORDER BY updated_at DESC
       LIMIT 1`,
      [dashboard, ownerSubject, now],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toRunRow(row);
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.pool.query(`DELETE FROM run_checkpoints WHERE expires_at <= $1`, [now]);
    return result.rowCount ?? 0;
  }
}

export class PgStore implements Store {
  readonly devices: DeviceStore;
  readonly pairingTokens: PairingTokenStore;
  readonly browserSessions: BrowserSessionStore;
  readonly artifacts: ArtifactMetaStore;
  readonly audit: AuditStore;
  readonly runCheckpoints: RunCheckpointStore;
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
    this.devices = new PgDevices(this.pool);
    this.pairingTokens = new PgPairingTokens(this.pool);
    this.browserSessions = new PgBrowserSessions(this.pool);
    this.artifacts = new PgArtifacts(this.pool);
    this.audit = new PgAudit(this.pool);
    this.runCheckpoints = new PgRunCheckpoints(this.pool);
  }

  async ready(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
