import type { Queryable } from '../pool.js';
import type { IsoDate } from '../../domain/week.js';
import type { DraftRecord, DraftState, GroupId, UserId } from './types.js';

interface DraftRow {
  id: number;
  user_id: number;
  group_id: number;
  week_start_date: string;
  state: DraftState;
}

function toRecord(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    userId: row.user_id,
    groupId: row.group_id,
    weekStartDate: row.week_start_date,
    state: row.state ?? {},
  };
}

const COLUMNS = 'id, user_id, group_id, week_start_date, state';

/**
 * Creates the draft, or returns the existing one untouched.
 *
 * The DO UPDATE deliberately only bumps updated_at rather than resetting state:
 * re-running /availability mid-week must RESUME, not restart. Someone who got
 * halfway through on the bus should not lose their answers.
 */
export async function startOrResumeDraft(
  db: Queryable,
  userId: UserId,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<DraftRecord> {
  const result = await db.query<DraftRow>(
    `INSERT INTO response_draft (user_id, group_id, week_start_date, state)
     VALUES ($1, $2, $3, '{}'::jsonb)
     ON CONFLICT (user_id, group_id, week_start_date)
     DO UPDATE SET updated_at = now()
     RETURNING ${COLUMNS}`,
    [userId, params.groupId, params.weekStartDate],
  );
  return toRecord(result.rows[0]!);
}

/**
 * Loads a draft by its surrogate id (which travels in the custom_id).
 *
 * Callers MUST check ownership against the acting user - a custom_id is just a
 * string the client sends back, so a draft id is not an authorization. See
 * draftService.loadOwnedDraft.
 */
export async function findDraftById(db: Queryable, id: number): Promise<DraftRecord | null> {
  const result = await db.query<DraftRow>(`SELECT ${COLUMNS} FROM response_draft WHERE id = $1`, [
    id,
  ]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function findDraftForSelf(
  db: Queryable,
  selfUserId: UserId,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<DraftRecord | null> {
  const result = await db.query<DraftRow>(
    `SELECT ${COLUMNS} FROM response_draft
     WHERE user_id = $1 AND group_id = $2 AND week_start_date = $3`,
    [selfUserId, params.groupId, params.weekStartDate],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** Whole-object write. The state is well under 1KB, so no JSON-path surgery. */
export async function saveDraftState(
  db: Queryable,
  id: number,
  state: DraftState,
): Promise<DraftRecord> {
  const result = await db.query<DraftRow>(
    `UPDATE response_draft SET state = $2::jsonb, updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, JSON.stringify(state)],
  );
  return toRecord(result.rows[0]!);
}

export async function deleteDraft(db: Queryable, id: number): Promise<void> {
  await db.query(`DELETE FROM response_draft WHERE id = $1`, [id]);
}

export async function deleteStaleDrafts(db: Queryable, olderThanDays: number): Promise<number> {
  const result = await db.query(
    `DELETE FROM response_draft WHERE updated_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)],
  );
  return result.rowCount ?? 0;
}
