import { isUniqueViolation, type Queryable } from '../pool.js';
import type { IsoDate } from '../../domain/week.js';
import type { GroupId, UserId } from './types.js';

export type BuzzStatus = 'pending' | 'sent' | 'failed';

/**
 * Claims today's single buzz for a target.
 *
 * Returns the new row's id, or null if the target has already been buzzed
 * today. The check is the partial unique index, not a preceding SELECT: two
 * people pressing Buzz at the same instant must resolve to exactly one DM, and
 * a read-then-write cannot promise that.
 *
 * The index is partial on `status <> 'failed'`, so an undeliverable buzz does
 * not burn the target's daily quota.
 */
export async function claimBuzz(
  db: Queryable,
  params: {
    groupId: GroupId;
    actorUserId: UserId;
    targetUserId: UserId;
    weekStartDate: IsoDate;
    buzzDate: IsoDate;
  },
): Promise<number | null> {
  try {
    const result = await db.query<{ id: number }>(
      `INSERT INTO buzz_log
         (group_id, actor_user_id, target_user_id, week_start_date, buzz_date, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [
        params.groupId,
        params.actorUserId,
        params.targetUserId,
        params.weekStartDate,
        params.buzzDate,
      ],
    );
    return result.rows[0]?.id ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

export async function markBuzzStatus(db: Queryable, id: number, status: BuzzStatus): Promise<void> {
  await db.query(`UPDATE buzz_log SET status = $2 WHERE id = $1`, [id, status]);
}

export async function wasBuzzedOn(
  db: Queryable,
  params: { targetUserId: UserId; buzzDate: IsoDate },
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM buzz_log
       WHERE target_user_id = $1 AND buzz_date = $2 AND status <> 'failed'
     ) AS exists`,
    [params.targetUserId, params.buzzDate],
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Frees up buzzes stuck in 'pending', which means a process died between
 * COMMIT and notify().
 *
 * This deliberately chooses duplicate-risk over silent-loss: the worst case is
 * one extra DM, and the alternative is a nudge that never arrives and a target
 * who cannot be nudged again.
 */
export async function expireStalePendingBuzzes(
  db: Queryable,
  olderThanMinutes: number,
): Promise<number> {
  const result = await db.query(
    `UPDATE buzz_log SET status = 'failed'
     WHERE status = 'pending' AND created_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return result.rowCount ?? 0;
}
