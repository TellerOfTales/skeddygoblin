import type { Queryable } from '../pool.js';
import type { IsoDate } from '../../domain/week.js';
import type { GroupId } from './types.js';

export type JobKind = 'weekly_prompt' | 'nudge_cutoff' | 'overlap_post' | 'steam_sync';

/**
 * Claims a job for a group and week.
 *
 * The primary key IS the lock. A returned row means this process won the race
 * and should run the job; no row means somebody already did. That keeps the
 * scheduler correct even if the single-instance assumption is violated during a
 * deploy - no double-posted leaderboards, no double weekly prompts.
 */
export async function claimJob(
  db: Queryable,
  params: { groupId: GroupId; jobKind: JobKind; weekStartDate: IsoDate },
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO job_run (group_id, job_kind, week_start_date)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING group_id`,
    [params.groupId, params.jobKind, params.weekStartDate],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function hasRun(
  db: Queryable,
  params: { groupId: GroupId; jobKind: JobKind; weekStartDate: IsoDate },
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM job_run WHERE group_id = $1 AND job_kind = $2 AND week_start_date = $3
     ) AS exists`,
    [params.groupId, params.jobKind, params.weekStartDate],
  );
  return result.rows[0]?.exists ?? false;
}

/** Releases a claim so the job can be retried, e.g. after a delivery failure. */
export async function releaseJob(
  db: Queryable,
  params: { groupId: GroupId; jobKind: JobKind; weekStartDate: IsoDate },
): Promise<void> {
  await db.query(
    `DELETE FROM job_run WHERE group_id = $1 AND job_kind = $2 AND week_start_date = $3`,
    [params.groupId, params.jobKind, params.weekStartDate],
  );
}
