/**
 * A member's own availability template, stored once and projected onto every
 * group they belong to.
 *
 * Every read here is self-scoped - this is per-user data of exactly the kind
 * the privacy rule protects, and it must never surface in a group view. The one
 * exception is listAutoApplyUserIds, which returns ids and nothing else so the
 * weekly prompt can decide whom to answer on behalf of.
 */

import type { Queryable } from '../pool.js';
import type { Day, VibeTag, Window } from '../../domain/constants.js';
import type { SlotRow, UserId } from './types.js';

export interface PersonalDefaults {
  slots: SlotRow[];
  capacity: number | undefined;
  vibes: VibeTag[];
  autoApply: boolean;
}

export async function listDefaultSlotsForSelf(
  db: Queryable,
  selfUserId: UserId,
): Promise<SlotRow[]> {
  const result = await db.query<{ day_of_week: number; window: Window }>(
    `SELECT day_of_week, "window"
       FROM user_default_slot
      WHERE user_id = $1
      ORDER BY day_of_week, "window"`,
    [selfUserId],
  );
  return result.rows.map((row) => ({ dayOfWeek: row.day_of_week as Day, window: row.window }));
}

export async function getDefaultsForSelf(
  db: Queryable,
  selfUserId: UserId,
): Promise<PersonalDefaults> {
  const result = await db.query<{
    default_capacity: number | null;
    default_vibes: string[];
    auto_apply_defaults: boolean;
  }>(
    `SELECT default_capacity, default_vibes, auto_apply_defaults
       FROM app_user WHERE id = $1`,
    [selfUserId],
  );

  const row = result.rows[0];
  return {
    slots: await listDefaultSlotsForSelf(db, selfUserId),
    capacity: row?.default_capacity ?? undefined,
    vibes: (row?.default_vibes ?? []) as VibeTag[],
    autoApply: row?.auto_apply_defaults ?? false,
  };
}

/**
 * Replaces the template wholesale.
 *
 * Delete-then-insert rather than a diff: the set is at most 42 rows, it is
 * written by one person editing one screen, and "whatever is on screen is what
 * is stored" is the only rule that cannot drift out of sync with the UI.
 */
export async function replaceDefaultSlotsForSelf(
  db: Queryable,
  selfUserId: UserId,
  slots: readonly SlotRow[],
): Promise<void> {
  await db.query('DELETE FROM user_default_slot WHERE user_id = $1', [selfUserId]);
  if (slots.length === 0) return;

  const values: unknown[] = [selfUserId];
  const tuples = slots.map((slot) => {
    values.push(slot.dayOfWeek, slot.window);
    return `($1, $${values.length - 1}, $${values.length})`;
  });

  await db.query(
    `INSERT INTO user_default_slot (user_id, day_of_week, "window")
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

export async function setDefaultPreferencesForSelf(
  db: Queryable,
  selfUserId: UserId,
  params: { capacity?: number | undefined; vibes?: readonly VibeTag[] | undefined },
): Promise<void> {
  await db.query(
    `UPDATE app_user
        SET default_capacity = COALESCE($2, default_capacity),
            default_vibes    = COALESCE($3, default_vibes)
      WHERE id = $1`,
    [selfUserId, params.capacity ?? null, params.vibes ? [...params.vibes] : null],
  );
}

export async function setAutoApplyForSelf(
  db: Queryable,
  selfUserId: UserId,
  autoApply: boolean,
): Promise<void> {
  await db.query('UPDATE app_user SET auto_apply_defaults = $2 WHERE id = $1', [
    selfUserId,
    autoApply,
  ]);
}

/**
 * Ids of members who asked to be answered for automatically, and who have a
 * template worth applying. Ids only - never the template itself.
 */
export async function listAutoApplyUserIds(
  db: Queryable,
  userIds: readonly UserId[],
): Promise<UserId[]> {
  if (userIds.length === 0) return [];

  const result = await db.query<{ id: number }>(
    `SELECT u.id
       FROM app_user u
      WHERE u.id = ANY($1::bigint[])
        AND u.auto_apply_defaults
        AND EXISTS (SELECT 1 FROM user_default_slot s WHERE s.user_id = u.id)`,
    [[...userIds]],
  );
  return result.rows.map((row) => row.id);
}
