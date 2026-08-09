/**
 * The overlap aggregate. One query, and the single most privacy-sensitive
 * statement in the codebase.
 *
 * Note what it never SELECTs: user_id. The result type has no identity field at
 * all, so a ranked window cannot leak who is free when even if a caller wanted
 * it to. That is the "aggregate only" principle expressed as a shape rather
 * than a rule.
 */

import type { Queryable } from '../pool.js';
import type { IsoDate } from '../../domain/week.js';
import { WINDOW_PREFERENCE, type Day, type Window } from '../../domain/constants.js';
import type { SlotAggregate } from '../../domain/overlap.js';
import type { GroupId } from './types.js';

/**
 * Window tie-break order, generated from the domain constant so the SQL cannot
 * drift from src/domain/overlap.ts. Values are ours, not user input.
 */
const WINDOW_PREFERENCE_CASE = `CASE s."window"
${Object.entries(WINDOW_PREFERENCE)
  .map(([window, rank]) => `      WHEN '${window}' THEN ${rank}`)
  .join('\n')}
      ELSE 99 END`;

/**
 * Scored (day, window) cells for a group's week.
 *
 * Mirrors scoreSlot() in src/domain/overlap.ts exactly:
 *
 *     score = headcount + (0.5 / N) * SUM(min(remaining, 4) / 4)
 *
 * where N is the number of submitted responders. The O1 test generates
 * randomised groups and asserts this query and the pure reference agree,
 * including ordering.
 *
 * @param minHeadcount k-anonymity floor. Enforced in HAVING, not in the view,
 *        so a one-person window is never returned at all.
 */
export async function rankWindowAggregate(
  db: Queryable,
  params: { groupId: GroupId; weekStartDate: IsoDate; minHeadcount: number; limit?: number },
): Promise<SlotAggregate[]> {
  const result = await db.query<{
    day_of_week: number;
    window: Window;
    headcount: number;
    score: number;
  }>(
    `WITH responders AS (
       SELECT wr.user_id,
              LEAST(GREATEST(wr.sessions_committed, 0), 4) AS committed
       FROM weekly_response wr
       WHERE wr.group_id = $1
         AND wr.week_start_date = $2
         -- opted-out members are excluded explicitly, not merely implicitly by
         -- having no slots, so the intent survives refactoring
         AND wr.status = 'submitted'
     ),
     confirmed AS (
       -- Sessions this member has already committed to this week. Usually zero
       -- until proposals are in play, which is correct rather than a stub.
       SELECT sa.user_id, COUNT(*)::int AS taken
       FROM session_attendance sa
       JOIN session_proposal sp ON sp.id = sa.proposal_id
       WHERE sp.group_id = $1
         AND sp.week_start_date = $2
         AND sp.status = 'confirmed'
         AND sa.response = 'yes'
       GROUP BY sa.user_id
     ),
     cap AS (
       SELECT r.user_id,
              GREATEST(r.committed - COALESCE(c.taken, 0), 0) AS remaining
       FROM responders r
       LEFT JOIN confirmed c ON c.user_id = r.user_id
     ),
     totals AS (
       SELECT GREATEST(COUNT(*), 1)::numeric AS n FROM responders
     )
     SELECT
       s.day_of_week,
       s."window" AS window,
       COUNT(*)::int AS headcount,
       (
         COUNT(*)::numeric
         + (0.5 / (SELECT n FROM totals))
           * SUM(LEAST(cap.remaining, 4)::numeric / 4.0)
       )::float8 AS score
     FROM availability_slot s
     JOIN cap ON cap.user_id = s.user_id
     WHERE s.group_id = $1
       AND s.week_start_date = $2
       -- someone with no sessions left should stop pulling the group toward
       -- slots they cannot attend
       AND cap.remaining > 0
     GROUP BY s.day_of_week, s."window"
     HAVING COUNT(*) >= $3
     ORDER BY score DESC,
              headcount DESC,
              ${WINDOW_PREFERENCE_CASE},
              s.day_of_week ASC
     LIMIT $4`,
    [params.groupId, params.weekStartDate, params.minHeadcount, params.limit ?? 20],
  );

  return result.rows.map((row) => ({
    dayOfWeek: row.day_of_week as Day,
    window: row.window,
    headcount: row.headcount,
    score: row.score,
  }));
}

/** Submitted responders in a group's week. The N in the scoring formula. */
export async function countSubmittedResponders(
  db: Queryable,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT COUNT(*)::bigint AS count FROM weekly_response
     WHERE group_id = $1 AND week_start_date = $2 AND status = 'submitted'`,
    [params.groupId, params.weekStartDate],
  );
  return result.rows[0]?.count ?? 0;
}
