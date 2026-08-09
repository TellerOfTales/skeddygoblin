import type { Queryable } from '../pool.js';
import type { IsoDate } from '../../domain/week.js';
import type { VibeTag } from '../../domain/constants.js';
import type { GroupId, UserId } from './types.js';

/** A member's own vibe picks. Self-scoped. */
export async function listVibesForSelf(
  db: Queryable,
  selfUserId: UserId,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<VibeTag[]> {
  const result = await db.query<{ tag: VibeTag }>(
    `SELECT tag FROM vibe_tag
     WHERE user_id = $1 AND group_id = $2 AND week_start_date = $3
     ORDER BY tag`,
    [selfUserId, params.groupId, params.weekStartDate],
  );
  return result.rows.map((row) => row.tag);
}

export async function replaceVibesForSelf(
  db: Queryable,
  selfUserId: UserId,
  params: { groupId: GroupId; weekStartDate: IsoDate },
  tags: readonly VibeTag[],
): Promise<number> {
  await db.query(
    `DELETE FROM vibe_tag WHERE user_id = $1 AND group_id = $2 AND week_start_date = $3`,
    [selfUserId, params.groupId, params.weekStartDate],
  );

  if (tags.length === 0) return 0;

  const result = await db.query(
    `INSERT INTO vibe_tag (user_id, group_id, week_start_date, tag)
     SELECT $1, $2, $3, tag FROM unnest($4::text[]) AS t(tag)
     ON CONFLICT DO NOTHING`,
    [selfUserId, params.groupId, params.weekStartDate, [...tags]],
  );
  return result.rowCount ?? 0;
}

/**
 * How many members picked each vibe this week.
 *
 * Aggregate: counts only, no user ids. This is what Stage 2's game matching
 * filters on, and what makes "the group is feeling chill" sayable without
 * revealing who said it.
 */
export async function countVibesAggregate(
  db: Queryable,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<Array<{ tag: VibeTag; count: number }>> {
  const result = await db.query<{ tag: VibeTag; count: number }>(
    `SELECT v.tag, COUNT(*)::bigint AS count
     FROM vibe_tag v
     JOIN weekly_response r
       ON r.user_id = v.user_id
      AND r.group_id = v.group_id
      AND r.week_start_date = v.week_start_date
     WHERE v.group_id = $1 AND v.week_start_date = $2 AND r.status = 'submitted'
     GROUP BY v.tag
     ORDER BY count DESC, v.tag ASC`,
    [params.groupId, params.weekStartDate],
  );
  return result.rows;
}
