/**
 * Migration + PostgreSQL store smoke (§21, §28 job 10). Runs when
 * DATABASE_URL is present (CI provides an ephemeral postgres:17 service);
 * skipped otherwise so `pnpm test` works from a clean checkout.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAuditEvent } from '@browser-bridge/audit';
import { hashPairingToken, newDeviceId, newRequestId } from '@browser-bridge/protocol';
import { migrateDown, migrateUp, migrationStatus, PgStore } from '@browser-bridge/gateway';

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

describe.skipIf(DATABASE_URL === undefined)('PostgreSQL migrations + store (§21)', () => {
  it('applies, reports, rolls back, and re-applies migrations', async () => {
    await migrateDown(DATABASE_URL!, MIGRATIONS_DIR, 99).catch(() => undefined);
    const applied = await migrateUp(DATABASE_URL!, MIGRATIONS_DIR);
    expect(applied).toEqual(['0001_init', '0002_run_checkpoints']);
    const status = await migrationStatus(DATABASE_URL!, MIGRATIONS_DIR);
    expect(status.applied).toEqual(['0001_init', '0002_run_checkpoints']);
    expect(status.pending).toHaveLength(0);
    // Down migrations are counted in steps from the newest, so one step is
    // one migration — asserting which one is what proves the ordering.
    expect(await migrateDown(DATABASE_URL!, MIGRATIONS_DIR, 1)).toEqual(['0002_run_checkpoints']);
    expect(await migrateDown(DATABASE_URL!, MIGRATIONS_DIR, 1)).toEqual(['0001_init']);
    const reapplied = await migrateUp(DATABASE_URL!, MIGRATIONS_DIR);
    expect(reapplied).toEqual(['0001_init', '0002_run_checkpoints']);
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
        buildAuditEvent({ actionClass: 'read', outcome: 'ok', toolName: 'browser_tabs', deviceId }),
      );
    } finally {
      await store.close();
    }
  });

  it('round-trips run checkpoints with expiry and owner isolation', async () => {
    const store = new PgStore(DATABASE_URL!);
    const now = new Date();
    const runId = `deals-pg-${newRequestId()}`;
    const base = {
      runId,
      dashboard: 'deals',
      ownerSubject: 'user-pg',
      status: 'running' as const,
      searched: ['ebay: lego bulk lot'],
      verifiedIds: ['ebay-226123456789'],
      pendingIds: ['kijiji-1740940278'],
      notes: 'Track A page 2 of 5',
      checkpointCount: 1,
      startedAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    };
    try {
      await store.runCheckpoints.put(base);
      const read = await store.runCheckpoints.get(runId, now);
      expect(read?.searched).toEqual(['ebay: lego bulk lot']);
      expect(read?.verifiedIds).toEqual(['ebay-226123456789']);
      expect(read?.pendingIds).toEqual(['kijiji-1740940278']);
      expect(read?.checkpointCount).toBe(1);

      // A second put is a faithful row write, every column included: this
      // layer is row CRUD, and "a later checkpoint does not restart a run"
      // is the service's rule, enforced by the startedAt it hands down
      // (tests/unit/runCheckpoints.test.ts).
      const later = new Date(now.getTime() + 60_000);
      await store.runCheckpoints.put({
        ...base,
        updatedAt: later,
        checkpointCount: 2,
        verifiedIds: ['ebay-226123456789', 'ebay-226999999991'],
      });
      const updated = await store.runCheckpoints.get(runId, later);
      expect(updated?.checkpointCount).toBe(2);
      expect(updated?.verifiedIds).toHaveLength(2);
      expect(updated?.startedAt.getTime()).toBe(now.getTime());
      expect(updated?.updatedAt.getTime()).toBe(later.getTime());

      expect((await store.runCheckpoints.latestResumable('deals', 'user-pg', later))?.runId).toBe(runId);
      // `owner_subject IS NOT DISTINCT FROM $2`: a null owner must not match
      // a named one, and SQL's `=` would have matched neither.
      expect(await store.runCheckpoints.latestResumable('deals', null, later)).toBeNull();
      expect(await store.runCheckpoints.latestResumable('vacation', 'user-pg', later)).toBeNull();

      // A completed run stays readable by id and stops being offered.
      await store.runCheckpoints.put({ ...base, status: 'completed', updatedAt: later, checkpointCount: 3 });
      expect((await store.runCheckpoints.get(runId, later))?.status).toBe('completed');
      expect(await store.runCheckpoints.latestResumable('deals', 'user-pg', later)).toBeNull();

      // Expiry is a read predicate, not just a sweeper: an expired row is
      // absent before anything deletes it, and the sweep then removes it.
      const afterTtl = new Date(base.expiresAt.getTime() + 1000);
      expect(await store.runCheckpoints.get(runId, afterTtl)).toBeNull();
      expect(await store.runCheckpoints.purgeExpired(afterTtl)).toBeGreaterThanOrEqual(1);
      expect(await store.runCheckpoints.get(runId, now)).toBeNull();
    } finally {
      await store.close();
    }
  });
});
