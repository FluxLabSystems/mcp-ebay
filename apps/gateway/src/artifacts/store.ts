/**
 * Ephemeral artifact storage — SDD v0.5 §16. Filesystem bytes + DB
 * metadata, default 15-minute TTL, cleanup every 5 minutes, short-TTL
 * HMAC-signed download URLs.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ARTIFACT_AGGREGATE_MAX_BYTES,
  ARTIFACT_MAX_BYTES,
  BridgeError,
  isAllowedArtifactMime,
} from '@browser-bridge/protocol';
import type { ArtifactMetaStore, ArtifactRow } from '../store/types.js';

export interface ArtifactStoreOptions {
  dir: string;
  ttlSeconds: number;
  publicBaseUrl: URL;
  /** HMAC secret for signed URLs; generated per boot when not configured. */
  urlSecret?: string;
  meta: ArtifactMetaStore;
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new BridgeError('INTERNAL_ERROR', `Unsafe artifact identifier.`, {});
  }
  return id;
}

export class ArtifactStore {
  private readonly options: ArtifactStoreOptions;
  private readonly secret: Buffer;

  constructor(options: ArtifactStoreOptions) {
    this.options = options;
    this.secret = Buffer.from(options.urlSecret ?? randomBytes(32).toString('base64url'), 'utf8');
  }

  get ttlSeconds(): number {
    return this.options.ttlSeconds;
  }

  async put(
    artifactId: string,
    requestId: string,
    mimeType: string,
    bytes: Buffer,
    ownerSubject: string | null,
  ): Promise<ArtifactRow> {
    safeId(artifactId);
    // Only passive raster images are storable (audit F-06): an SVG/HTML
    // artifact could otherwise render as active content on the gateway origin.
    if (!isAllowedArtifactMime(mimeType)) {
      throw new BridgeError('DOWNLOAD_BLOCKED', `Artifact MIME type "${mimeType}" is not permitted.`, { mimeType });
    }
    if (bytes.length > ARTIFACT_MAX_BYTES) {
      throw new BridgeError('ARTIFACT_TOO_LARGE', undefined, { byteLength: bytes.length });
    }
    const aggregate = await this.options.meta.aggregateBytesForRequest(requestId);
    if (aggregate + bytes.length > ARTIFACT_AGGREGATE_MAX_BYTES) {
      throw new BridgeError('ARTIFACT_TOO_LARGE', 'Aggregate artifact size for this tool call exceeds the limit.', {
        aggregate: aggregate + bytes.length,
      });
    }
    await mkdir(this.options.dir, { recursive: true });
    const storagePath = join(this.options.dir, `${artifactId}.bin`);
    await writeFile(storagePath, bytes);
    const now = new Date();
    const row: ArtifactRow = {
      artifactId,
      requestId,
      ownerSubject,
      mimeType,
      byteLength: bytes.length,
      storagePath,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.options.ttlSeconds * 1000),
    };
    await this.options.meta.insert(row);
    return row;
  }

  async get(artifactId: string): Promise<{ row: ArtifactRow; bytes: Buffer } | null> {
    const row = await this.options.meta.get(safeId(artifactId));
    if (row === null) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.deleteRow(row);
      return null;
    }
    try {
      const bytes = await readFile(row.storagePath);
      return { row, bytes };
    } catch {
      await this.options.meta.delete(row.artifactId);
      return null;
    }
  }

  /** Signed HTTPS download URL (§16): expires with the artifact. */
  signedUrl(row: ArtifactRow): string {
    const exp = Math.floor(row.expiresAt.getTime() / 1000);
    const sig = this.sign(row.artifactId, exp);
    const url = new URL(`/artifacts/${row.artifactId}`, this.options.publicBaseUrl);
    url.searchParams.set('exp', String(exp));
    url.searchParams.set('sig', sig);
    return url.toString();
  }

  verifySignature(artifactId: string, exp: number, sig: string): boolean {
    if (exp * 1000 <= Date.now()) return false;
    const expected = this.sign(artifactId, exp);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sig, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private sign(artifactId: string, exp: number): string {
    return createHmac('sha256', this.secret).update(`${artifactId}\n${exp}`).digest('base64url');
  }

  /** Cleanup job (§16, §21): delete expired artifacts and their files. */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.options.meta.listExpired(now);
    for (const row of expired) {
      await this.deleteRow(row);
    }
    return expired.length;
  }

  private async deleteRow(row: ArtifactRow): Promise<void> {
    await rm(row.storagePath, { force: true }).catch(() => undefined);
    await this.options.meta.delete(row.artifactId);
  }
}
