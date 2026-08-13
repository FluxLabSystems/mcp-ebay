/**
 * Migration + PostgreSQL store smoke (§21, §28 job 10). Runs when
 * DATABASE_URL is present (CI provides an ephemeral postgres:17 service);
 * skipped otherwise so `pnpm test` works from a clean checkout.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAuditEvent } from '@browser-bridge/audit';
import { hashPairingToken, newDeviceId } from '@browser-bridge/protocol';
import { migrateDown, migrateUp, migrationStatus, PgStore } from '@browser-bridge/gateway';

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

describe.skipIf(DATABASE_URL === undefined)('PostgreSQL migrations + store (§21)', () => {
  it('applies, reports, rolls back, and re-applies migrations', async () => {
    await migrateDown(DATABASE_URL!, MIGRATIONS_DIR, 99).catch(() => undefined);
    const applied = await migrateUp(DATABASE_URL!, MIGRATIONS_DIR);
    expect(applied).toContain('0001_init');
    const status = await migrationStatus(DATABASE_URL!, MIGRATIONS_DIR);
    expect(status.applied).toContain('0001_init');
    expect(status.pending).toHaveLength(0);
    const reverted = await migrateDown(DATABASE_URL!, MIGRATIONS_DIR, 1);
    expect(reverted).toContain('0001_init');
    const reapplied = await migrateUp(DATABASE_URL!, MIGRATIONS_DIR);
    expect(reapplied).toContain('0001_init');
  });

  it('round-trips devices, single-use pairing tokens, sessions, artifacts, audit', async () => {
    const store = new PgStore(DATABASE_URL!);
    try {
      expect(await store.ready()).toBe(true);

      const deviceId = newDeviceId();
      await store.devices.insert({
        deviceId,
        name: 'pg-test',
        publicKeyEd25519: Buffer.from('test-key'),
        keyFingerprint: `fp-${deviceId}`,
        status: 'active',
        agentVersion: null,
        pairedAt: new Date(),
        lastSeenAt: null,
      });
      expect((await store.devices.get(deviceId))?.name).toBe('pg-test');
      expect(await store.devices.setStatus(deviceId, 'revoked')).toBe(true);
      expect((await store.devices.get(deviceId))?.status).toBe('revoked');

      const hash = hashPairingToken(`token-${deviceId}`);
      await store.pairingTokens.insert(hash, 'pg-test', new Date(Date.now() + 60_000));
      expect(await store.pairingTokens.consume(hash, new Date())).toEqual({ requestedName: 'pg-test' });
      expect(await store.pairingTokens.consume(hash, new Date())).toBeNull(); // single use

      const handle = `bs_pg_${deviceId.slice(4)}`;
      await store.browserSessions.upsert({
        browserSessionHandle: handle,
        deviceId,
        profileName: 'ebay-research',
        status: 'ready',
        openedAt: new Date(),
        lastSeenAt: new Date(),
        closedAt: null,
      });
      expect((await store.browserSessions.get(handle))?.deviceId).toBe(deviceId);

      const artifactId = `art_pg_${deviceId.slice(4)}`;
      await store.artifacts.insert({
        artifactId,
        requestId: 'req-pg-1',
        ownerSubject: null,
        mimeType: 'image/png',
        byteLength: 10,
        storagePath: '/tmp/none',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await store.artifacts.aggregateBytesForRequest('req-pg-1')).toBe(10);
      const expired = await store.artifacts.listExpired(new Date());
      expect(expired.some((row) => row.artifactId === artifactId)).toBe(true);
      await store.artifacts.delete(artifactId);

      await store.audit.insert(
        buildAuditEvent({ actionClass: 'read', outcome: 'ok', toolName: 'browser.tabs', deviceId }),
      );
    } finally {
      await store.close();
    }
  });
});
