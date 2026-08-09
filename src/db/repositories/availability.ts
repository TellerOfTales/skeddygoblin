import type { Queryable } from '../pool.js';
import type { IsoDate } from '../../domain/week.js';
import type { Day, Window } from '../../domain/constants.js';
import type { GroupId, SlotRow, UserId } from './types.js';

/**
 * A member's own slots. Self-scoped: `selfUserId` is both the filter and the
 * authorization, and the SQL carries `user_id = $1`.
 *
 * There is deliberately no sibling function that returns slots for anyone else,
 * or for a whole group with user ids attached. Group-level reads go through the
 * aggregate query in overlap.ts, whose result type has no identity field.
 */
export async function listSlotsForSelf(
  db: Queryable,
  selfUserId: UserId,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<SlotRow[]> {
  const result = await db.query<{ day_of_week: number; window: Window }>(
    `SELECT day_of_week, "window"
     FROM availability_slot
     WHERE user_id = $1 AND group_id = $2 AND week_start_date = $3
     ORDER BY day_of_week, "window"`,
    [selfUserId, params.groupId, params.weekStartDate],
  );
  return result.rows.map((row) => ({ dayOfWeek: row.day_of_week as Day, window: row.window }));
}

/**
 * Replaces a member's slots for the week wholesale.
 *
 * Delete-then-insert rather than a diff: the set is at most 42 rows, the flow
 * always knows the complete intended state, and "replace" cannot drift the way
 * an incremental merge can. Must run inside the same transaction as the
 * weekly_response upsert - the composite FK requires the parent row to exist.
 */
export async function replaceSlotsForSelf(
  db: Queryable,
  selfUserId: UserId,
  params: { groupId: GroupId; weekStartDate: IsoDate },
  slots: readonly SlotRow[],
): Promise<number> {
  await db.query(
    `DELETE FROM availability_slot
     WHERE user_id = $1 AND group_id = $2 AND week_start_date = $3`,
    [selfUserId, params.groupId, params.weekStartDate],
  );

  if (slots.length === 0) return 0;

  // One statement via unnest rather than N round trips.
  const days = slots.map((slot) => slot.dayOfWeek);
  const windows = slots.map((slot) => slot.window);

  const result = await db.query(
    `INSERT INTO availability_slot (user_id, group_id, week_start_date, day_of_week, "window")
     SELECT $1, $2, $3, day, win
     FROM unnest($4::smallint[], $5::availability_window[]) AS t(day, win)
     ON CONFLICT DO NOTHING`,
    [selfUserId, params.groupId, params.weekStartDate, days, windows],
  );
  return result.rowCount ?? 0;
}

export async function countSlotsForGroup(
  db: Queryable,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT COUNT(*)::bigint AS count FROM availability_slot
     WHERE group_id = $1 AND week_start_date = $2`,
    [params.groupId, params.weekStartDate],
  );
  return result.rows[0]?.count ?? 0;
}
