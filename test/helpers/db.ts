/**
 * Integration-test harness.
 *
 * Each test runs inside a transaction that is rolled back afterwards, so tests
 * cannot see each other's rows and no cleanup code is needed.
 *
 * This is exactly why `withTransaction` in src/db/pool.ts must be re-entrant:
 * the services under test open their own transactions, and if those issued a
 * real BEGIN/COMMIT they would commit through the harness's outer transaction
 * and leak. Nested calls issue SAVEPOINTs instead.
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createDbFromClient, type Db } from '../../src/db/pool.js';
import { RecordingNotifier } from '../../src/notify/RecordingNotifier.js';
import type { AppContext, Clock } from '../../src/services/context.js';
import type { Logger } from '../../src/logger.js';

const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  process.env.DATABASE_URL ??
  'postgres://skeddy:skeddy@127.0.0.1:5432/skeddygoblin_test';

let pool: pg.Pool | undefined;
let migrated = false;

export function testPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
  return pool;
}

export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await migrate(testPool());
  migrated = true;
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
  migrated = false;
}

/** A clock frozen at a known instant, advanceable by tests. */
export class FakeClock implements Clock {
  constructor(private current: Date = new Date('2026-08-12T12:00:00Z')) {}
  now(): Date {
    return this.current;
  }
  set(instant: Date | string): void {
    this.current = typeof instant === 'string' ? new Date(instant) : instant;
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

/** Silent logger, so a failing test's output is only its own assertions. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

export interface TestContext extends AppContext {
  notifier: RecordingNotifier;
  clock: FakeClock;
  db: Db;
}

/**
 * Runs `fn` against a context bound to a transaction that is always rolled
 * back, even when the test fails.
 */
export async function withRollback<T>(fn: (ctx: TestContext) => Promise<T>): Promise<T> {
  await ensureMigrated();

  const client = await testPool().connect();
  try {
    await client.query('BEGIN');
    const ctx: TestContext = {
      db: createDbFromClient(client),
      logger: silentLogger,
      clock: new FakeClock(),
      notifier: new RecordingNotifier(),
    };
    return await fn(ctx);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Like withRollback, but the work is COMMITTED and then torn down explicitly.
 *
 * Needed only by tests that require genuinely concurrent transactions - two
 * simultaneous buzz attempts, for instance - which by definition cannot share
 * one client. Everything else should use withRollback.
 */
export async function withCommitted<T>(
  fn: (ctx: TestContext, guildId: string) => Promise<T>,
): Promise<T> {
  await ensureMigrated();

  const { createDb } = await import('../../src/db/pool.js');
  const guildId = `test-guild-${randomUUID()}`;

  const ctx: TestContext = {
    db: createDb(testPool()),
    logger: silentLogger,
    clock: new FakeClock(),
    notifier: new RecordingNotifier(),
  };

  try {
    return await fn(ctx, guildId);
  } finally {
    // app_group cascades to memberships, responses, slots, vibes, drafts,
    // buzz logs, proposals and job runs.
    await testPool().query('DELETE FROM app_group WHERE discord_guild_id = $1', [guildId]);
    await testPool().query(
      `DELETE FROM app_user
       WHERE discord_id LIKE $1
         AND NOT EXISTS (SELECT 1 FROM group_membership m WHERE m.user_id = app_user.id)`,
      [`test-user-${guildId}-%`],
    );
  }
}
