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

export interface Store {
  devices: DeviceStore;
  pairingTokens: PairingTokenStore;
  browserSessions: BrowserSessionStore;
  artifacts: ArtifactMetaStore;
  audit: AuditStore;
  /** Readiness probe (§26 /readyz). */
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
