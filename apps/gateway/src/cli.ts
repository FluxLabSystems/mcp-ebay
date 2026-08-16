#!/usr/bin/env node
/**
 * Gateway administrative CLI — SDD v0.5 §11.2, §21, §32.
 *
 *   browser-bridge-gateway device:pair --name <device-name>
 *   browser-bridge-gateway device:list
 *   browser-bridge-gateway device:revoke --device-id <dev_...>
 *   browser-bridge-gateway migrate <up|down|status>
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  generatePairingToken,
  hashPairingToken,
  PAIRING_TOKEN_TTL_SECONDS,
} from '@browser-bridge/protocol';
import { migrateDown, migrateUp, migrationStatus } from './db/migrate.js';
import { PgStore } from './store/pg.js';

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, 'true');
      }
    }
  }
  return flags;
}

function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR !== undefined) return process.env.MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli.js → ../../../../db/migrations is apps/gateway/../../db/migrations
  return resolve(here, '../../../db/migrations');
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  return url;
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);

  switch (command) {
    case 'device:pair': {
      const store = new PgStore(requireDatabaseUrl());
      try {
        const name = flags.get('name') ?? null;
        const token = generatePairingToken();
        const expiresAt = new Date(Date.now() + PAIRING_TOKEN_TTL_SECONDS * 1000);
        await store.pairingTokens.insert(hashPairingToken(token), name, expiresAt);
        console.log('One-time pairing token (valid 10 minutes, single use):');
        console.log('');
        console.log(`  ${token}`);
        console.log('');
        console.log('On the Windows PC run:');
        console.log(`  browser-bridge-agent pair --token ${token}${name === null ? '' : ` --name "${name}"`}`);
      } finally {
        await store.close();
      }
      return 0;
    }
    case 'device:list': {
      const store = new PgStore(requireDatabaseUrl());
      try {
        const devices = await store.devices.list();
        for (const device of devices) {
          console.log(
            `${device.deviceId}\t${device.status}\t${device.name}\t${device.keyFingerprint}\tlast_seen=${device.lastSeenAt?.toISOString() ?? 'never'}`,
          );
        }
        if (devices.length === 0) console.log('(no paired devices)');
      } finally {
        await store.close();
      }
      return 0;
    }
    case 'device:revoke': {
      const deviceId = flags.get('device-id');
      if (deviceId === undefined) {
        console.error('Usage: browser-bridge-gateway device:revoke --device-id <dev_...>');
        return 2;
      }
      const store = new PgStore(requireDatabaseUrl());
      try {
        const changed = await store.devices.setStatus(deviceId, 'revoked');
        console.log(changed ? `Revoked ${deviceId}` : `Device ${deviceId} not found`);
        return changed ? 0 : 1;
      } finally {
        await store.close();
      }
    }
    case 'migrate': {
      const action = rest.find((arg) => !arg.startsWith('--')) ?? 'up';
      const url = requireDatabaseUrl();
      const dir = migrationsDir();
      if (action === 'up') {
        const applied = await migrateUp(url, dir);
        console.log(applied.length === 0 ? 'No pending migrations.' : `Applied: ${applied.join(', ')}`);
      } else if (action === 'down') {
        const steps = Number.parseInt(flags.get('steps') ?? '1', 10);
        const reverted = await migrateDown(url, dir, steps);
        console.log(reverted.length === 0 ? 'Nothing to revert.' : `Reverted: ${reverted.join(', ')}`);
      } else if (action === 'status') {
        const status = await migrationStatus(url, dir);
        console.log(`applied: ${status.applied.join(', ') || '(none)'}`);
        console.log(`pending: ${status.pending.join(', ') || '(none)'}`);
      } else {
        console.error('Usage: browser-bridge-gateway migrate <up|down|status> [--steps N]');
        return 2;
      }
      return 0;
    }
    default:
      console.error('Usage: browser-bridge-gateway <device:pair|device:list|device:revoke|migrate> [flags]');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
