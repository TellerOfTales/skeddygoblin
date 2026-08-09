/**
 * Migration runner.
 *
 * Deliberately hand-rolled and deliberately plain .sql: the project brief hands
 * us the data model verbatim and asks for fidelity to it, and a plain SQL file
 * can be reviewed line-for-line against that brief in a way a JS migration DSL
 * cannot.
 *
 * Semantics: an advisory lock serialises concurrent runners, each unapplied
 * file runs inside its own transaction together with its schema_migrations row,
 * and there are no down-migrations - roll forward.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type pg from 'pg';
import type { Queryable } from './pool.js';
import { createPool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Arbitrary but stable key so two runners cannot interleave. */
const MIGRATION_LOCK_KEY = 0x5eed_60b1;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

async function appliedVersions(db: Queryable): Promise<Set<string>> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const result = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(result.rows.map((row) => row.version));
}

/**
 * Applies every pending migration. Safe to call at boot on every start.
 */
export async function migrate(
  pool: pg.Pool,
  log: (message: string) => void = () => {},
): Promise<MigrationResult> {
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    const done = await appliedVersions(client);
    const files = await listMigrationFiles();

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) {
        alreadyApplied.push(version);
        continue;
      }

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`applying ${version}`);

      // The migration body and its bookkeeping row commit together, so a
      // crash mid-file can never leave a half-applied version recorded.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${version} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      applied.push(version);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }

  return { applied, alreadyApplied };
}

// ---------------------------------------------------------------------------
// CLI entrypoint: npm run migrate
// ---------------------------------------------------------------------------

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isCli) {
  const pool = createPool();
  try {
    const result = await migrate(pool, (message) => console.log(message));
    if (result.applied.length === 0) {
      console.log(`up to date (${result.alreadyApplied.length} migrations applied previously)`);
    } else {
      console.log(`applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
