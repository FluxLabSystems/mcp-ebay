/**
 * SQL migration runner — SDD v0.5 §21. Migrations are plain SQL files
 * committed under db/migrations as NNNN_name.up.sql / NNNN_name.down.sql,
 * applied in order inside transactions and recorded in schema_migrations.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const { Client } = pg;

export interface MigrationFile {
  version: string;
  upPath: string;
  downPath: string | null;
}

export async function discoverMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const ups = entries.filter((name) => name.endsWith('.up.sql')).sort();
  return ups.map((up) => {
    const version = up.replace(/\.up\.sql$/, '');
    const down = `${version}.down.sql`;
    return {
      version,
      upPath: join(dir, up),
      downPath: entries.includes(down) ? join(dir, down) : null,
    };
  });
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

export async function migrateUp(databaseUrl: string, dir: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await ensureMigrationsTable(client);
    const done = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((row) => (row as { version: string }).version),
    );
    for (const migration of await discoverMigrations(dir)) {
      if (done.has(migration.version)) continue;
      const sql = await readFile(migration.upPath, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.version} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(migration.version);
    }
  } finally {
    await client.end();
  }
  return applied;
}

export async function migrateDown(databaseUrl: string, dir: string, steps = 1): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const reverted: string[] = [];
  try {
    await ensureMigrationsTable(client);
    const appliedRows = (await client.query('SELECT version FROM schema_migrations ORDER BY version DESC')).rows as Array<{
      version: string;
    }>;
    const migrations = await discoverMigrations(dir);
    for (const row of appliedRows.slice(0, steps)) {
      const migration = migrations.find((candidate) => candidate.version === row.version);
      if (migration === undefined || migration.downPath === null) {
        throw new Error(`No down migration available for ${row.version}`);
      }
      const sql = await readFile(migration.downPath, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [row.version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Down migration ${row.version} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      reverted.push(row.version);
    }
  } finally {
    await client.end();
  }
  return reverted;
}

export async function migrationStatus(
  databaseUrl: string,
  dir: string,
): Promise<{ applied: string[]; pending: string[] }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const done = new Set(
      (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(
        (row) => (row as { version: string }).version,
      ),
    );
    const all = await discoverMigrations(dir);
    return {
      applied: all.filter((migration) => done.has(migration.version)).map((migration) => migration.version),
      pending: all.filter((migration) => !done.has(migration.version)).map((migration) => migration.version),
    };
  } finally {
    await client.end();
  }
}
