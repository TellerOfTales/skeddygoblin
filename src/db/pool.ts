/**
 * Connection pool, type parsers, and a re-entrant transaction helper.
 */

import pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Type parsers - MUST be registered before the first query.
// ---------------------------------------------------------------------------

/**
 * DATE (oid 1082) is returned by node-postgres as a JS Date in the *server
 * process's local timezone* by default, which silently shifts week_start_date
 * by a day for anyone west of UTC. We want the raw 'YYYY-MM-DD' string: our
 * dates are calendar dates with no time or zone, and that is exactly how
 * src/domain/week.ts models them.
 */
pg.types.setTypeParser(1082, (value: string) => value);

/** INT8 and NUMERIC default to strings to avoid precision loss. Our counts and
 * scores are small; numbers are far more convenient and safe here. */
pg.types.setTypeParser(20, (value: string) => Number(value));
pg.types.setTypeParser(1700, (value: string) => Number(value));

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Anything that can run a query: the pool, a client, or a transaction. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface Db extends Queryable {
  /**
   * Runs `fn` inside a transaction.
   *
   * Re-entrant: if the receiver is already inside a transaction, this opens a
   * SAVEPOINT instead of a nested BEGIN. That matters for two reasons - a
   * service that composes two other transactional services still gets
   * all-or-nothing semantics, and the test harness can wrap each test in an
   * outer transaction it rolls back without services silently committing real
   * rows underneath it.
   */
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

let savepointCounter = 0;

function clientDb(client: pg.PoolClient, depth: number): Db {
  return {
    query: (text, values) => client.query(text, values ? [...values] : undefined),

    async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const name = `sg_sp_${++savepointCounter}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn(clientDb(client, depth + 1));
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      }
    },
  };
}

export function createDb(pool: pg.Pool): Db {
  return {
    query: (text, values) => pool.query(text, values ? [...values] : undefined),

    async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(clientDb(client, 1));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          /* connection already broken; the pool will discard it */
        });
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Wraps an already-checked-out client as a Db whose withTransaction uses
 * savepoints. Used by the test harness, which holds an open transaction it
 * rolls back after each test.
 */
export function createDbFromClient(client: pg.PoolClient): Db {
  return clientDb(client, 1);
}

export function createPool(connectionString: string = config.database.url): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: config.database.poolMax,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: 'skeddygoblin',
  });
}

// ---------------------------------------------------------------------------
// Locking helpers
// ---------------------------------------------------------------------------

/**
 * Takes a transaction-scoped advisory lock keyed on an arbitrary string.
 * Released automatically at COMMIT/ROLLBACK.
 *
 * Used to serialise "check then act" sequences that a unique index alone cannot
 * cover - notably buzz eligibility versus a concurrent response submission,
 * which touch different tables and so cannot collide on a constraint.
 */
export async function advisoryXactLock(db: Queryable, key: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/**
 * Takes a session-scoped advisory lock, returning false if another session
 * holds it. Used by the scheduler to enforce the single-instance assumption.
 */
export async function tryAdvisorySessionLock(db: Queryable, key: string): Promise<boolean> {
  const result = await db.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
    [key],
  );
  return result.rows[0]?.locked === true;
}

/** Postgres unique-violation SQLSTATE. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
