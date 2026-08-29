/**
 * Persistence interfaces — SDD v0.5 §21. PostgreSQL 17 in production;
 * an in-memory implementation backs tests and local development. Browser
 * cookies, passwords, payment credentials, and profile data are never
 * stored.
 */
import type { AuditEvent } from '@browser-bridge/audit';

export interface DeviceRow {
  deviceId: string;
  name: string;
  publicKeyEd25519: Buffer;
  keyFingerprint: string;
  status: 'active' | 'revoked';
  agentVersion: string | null;
  pairedAt: Date;
  lastSeenAt: Date | null;
}

export interface DeviceStore {
  insert(device: DeviceRow): Promise<void>;
  get(deviceId: string): Promise<DeviceRow | null>;
  list(): Promise<DeviceRow[]>;
  setStatus(deviceId: string, status: 'active' | 'revoked'): Promise<boolean>;
  touchLastSeen(deviceId: string, at: Date, agentVersion?: string): Promise<void>;
}

export interface PairingTokenStore {
  /** Stores only the SHA-256 hash (§11). */
  insert(tokenHash: Buffer, requestedName: string | null, expiresAt: Date): Promise<void>;
  /** Atomically consume an unexpired, unconsumed token; null when invalid. */
  consume(tokenHash: Buffer, now: Date): Promise<{ requestedName: string | null } | null>;
  purgeExpired(now: Date): Promise<number>;
}

export interface BrowserSessionRow {
  browserSessionHandle: string;
  deviceId: string;
  profileName: string;
  status: 'ready' | 'degraded' | 'closed';
  openedAt: Date;
  lastSeenAt: Date;
  closedAt: Date | null;
}

export interface BrowserSessionStore {
  upsert(row: BrowserSessionRow): Promise<void>;
  get(handle: string): Promise<BrowserSessionRow | null>;
  markClosedForDevice(deviceId: string, at: Date): Promise<void>;
}

export interface ArtifactRow {
  artifactId: string;
  requestId: string;
  ownerSubject: string | null;
  mimeType: string;
  byteLength: number;
  storagePath: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface ArtifactMetaStore {
  insert(row: ArtifactRow): Promise<void>;
  get(artifactId: string): Promise<ArtifactRow | null>;
  listExpired(now: Date): Promise<ArtifactRow[]>;
  delete(artifactId: string): Promise<void>;
  aggregateBytesForRequest(requestId: string): Promise<number>;
}

export interface AuditStore {
  insert(event: AuditEvent): Promise<void>;
}

/**
 * One scheduled research run's checkpoint (Phase 4). audit_events answers
 * "what calls happened" and is insert-only by design, so it can never
 * answer "what has this run already verified"; this row is the run's own
 * state, written explicitly by the run and read back by the next turn.
 *
 * Rows hold identifiers and counts only — never scraped page content — and
 * expire, so a run that is never completed cleans itself up.
 */
export interface RunCheckpointRow {
  runId: string;
  /** Dashboard the run feeds; also what its OAuth scopes are keyed on. */
  dashboard: string;
  /** OAuth subject that owns the run; null when OAuth is disabled. */
  ownerSubject: string | null;
  status: 'running' | 'completed' | 'abandoned';
  searched: string[];
  verifiedIds: string[];
  pendingIds: string[];
  notes: string | null;
  checkpointCount: number;
  startedAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/**
 * Row CRUD only. Merge, bounds and the resumable rule live one layer up in
 * apps/gateway/src/runs/checkpoints.ts so the in-memory and PostgreSQL
 * implementations cannot drift apart on the semantics that matter.
 */
export interface RunCheckpointStore {
  put(row: RunCheckpointRow): Promise<void>;
  /** Expired rows read as absent, whether or not the sweeper has run. */
  get(runId: string, now: Date): Promise<RunCheckpointRow | null>;
  /**
   * Most recently updated unexpired run with status 'running' for this
   * dashboard and owner. Ownership is matched exactly, null included, so
   * one caller can never resume another caller's run.
   */
  latestResumable(dashboard: string, ownerSubject: string | null, now: Date): Promise<RunCheckpointRow | null>;
  purgeExpired(now: Date): Promise<number>;
}

export interface Store {
  devices: DeviceStore;
  pairingTokens: PairingTokenStore;
  browserSessions: BrowserSessionStore;
  artifacts: ArtifactMetaStore;
  audit: AuditStore;
  runCheckpoints: RunCheckpointStore;
  /** Readiness probe (§26 /readyz). */
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
