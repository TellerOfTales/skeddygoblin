import type { Queryable } from '../pool.js';
import type { IsoDate } from '../../domain/week.js';
import type {
  GroupId,
  RosterEntry,
  UserId,
  WeeklyResponseRecord,
  WeeklyResponseStatus,
} from './types.js';

interface ResponseRow {
  id: number;
  user_id: number;
  group_id: number;
  week_start_date: string;
  status: WeeklyResponseStatus;
  sessions_committed: number;
}

function toRecord(row: ResponseRow): WeeklyResponseRecord {
  return {
    id: row.id,
    userId: row.user_id,
    groupId: row.group_id,
    weekStartDate: row.week_start_date,
    status: row.status,
    sessionsCommitted: row.sessions_committed,
  };
}

const COLUMNS = 'id, user_id, group_id, week_start_date, status, sessions_committed';

// ---------------------------------------------------------------------------
// Self-scoped reads
// ---------------------------------------------------------------------------

/**
 * A member's own response. `selfUserId` is both the filter and the
 * authorization: services only ever pass the id resolved from the acting
 * interaction, so there is no path by which one member reads another's.
 */
export async function getResponseForSelf(
  db: Queryable,
  selfUserId: UserId,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<WeeklyResponseRecord | null> {
  const result = await db.query<ResponseRow>(
    `SELECT ${COLUMNS} FROM weekly_response
     WHERE user_id = $1 AND group_id = $2 AND week_start_date = $3`,
    [selfUserId, params.groupId, params.weekStartDate],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * The escape hatch. Idempotent: tapping "Can't this week" twice, or after
 * having submitted, converges on the same single opted-out row.
 */
export async function optOut(
  db: Queryable,
  userId: UserId,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<WeeklyResponseRecord> {
  const result = await db.query<ResponseRow>(
    `INSERT INTO weekly_response (user_id, group_id, week_start_date, status, sessions_committed)
     VALUES ($1, $2, $3, 'opted_out', 0)
     ON CONFLICT (user_id, group_id, week_start_date)
     DO UPDATE SET status = 'opted_out', sessions_committed = 0, submitted_at = now()
     RETURNING ${COLUMNS}`,
    [userId, params.groupId, params.weekStartDate],
  );
  return toRecord(result.rows[0]!);
}

export async function submit(
  db: Queryable,
  userId: UserId,
  params: { groupId: GroupId; weekStartDate: IsoDate; sessionsCommitted: number },
): Promise<WeeklyResponseRecord> {
  const result = await db.query<ResponseRow>(
    `INSERT INTO weekly_response (user_id, group_id, week_start_date, status, sessions_committed)
     VALUES ($1, $2, $3, 'submitted', $4)
     ON CONFLICT (user_id, group_id, week_start_date)
     DO UPDATE SET status = 'submitted', sessions_committed = EXCLUDED.sessions_committed,
                   submitted_at = now()
     RETURNING ${COLUMNS}`,
    [userId, params.groupId, params.weekStartDate, params.sessionsCommitted],
  );
  return toRecord(result.rows[0]!);
}

// ---------------------------------------------------------------------------
// Aggregate reads - no user identity alongside a preference value
// ---------------------------------------------------------------------------

/**
 * Whether a member has responded AT ALL this week, ignoring which way.
 *
 * This is the buzz eligibility primitive. It checks row existence rather than
 * status because opting out counts as responding - that is the entire point of
 * the escape hatch.
 */
export async function hasResponded(
  db: Queryable,
  params: { userId: UserId; groupId: GroupId; weekStartDate: IsoDate },
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM weekly_response
       WHERE user_id = $1 AND group_id = $2 AND week_start_date = $3
     ) AS exists`,
    [params.userId, params.groupId, params.weekStartDate],
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Ids of members who have responded. Identity WITHOUT preference - the
 * deliberate seam that lets the roster exist.
 *
 * Note what is NOT selected: `status`. Distinguishing "opted out" from
 * "submitted" would be a preference disclosure, so no group-scoped query ever
 * reads that column. See the P3 test.
 */
export async function listRespondedUserIds(
  db: Queryable,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<UserId[]> {
  const result = await db.query<{ user_id: number }>(
    `SELECT user_id FROM weekly_response
     WHERE group_id = $1 AND week_start_date = $2
     ORDER BY user_id`,
    [params.groupId, params.weekStartDate],
  );
  return result.rows.map((row) => row.user_id);
}

export async function countRespondersAggregate(
  db: Queryable,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<{ responded: number; total: number }> {
  const result = await db.query<{ responded: number; total: number }>(
    `SELECT
       (SELECT COUNT(*)::bigint FROM weekly_response
          WHERE group_id = $1 AND week_start_date = $2) AS responded,
       (SELECT COUNT(*)::bigint FROM group_membership WHERE group_id = $1) AS total`,
    [params.groupId, params.weekStartDate],
  );
  return { responded: result.rows[0]?.responded ?? 0, total: result.rows[0]?.total ?? 0 };
}

/**
 * The status roster: every member, with a BOOLEAN for whether they answered.
 *
 * Never the status value itself. `discord_id` is included so the view can
 * render a <@id> mention (which Discord resolves client-side, so no display
 * name is ever stored).
 */
export async function listRosterEntries(
  db: Queryable,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<RosterEntry[]> {
  const result = await db.query<{ user_id: number; discord_id: string; has_responded: boolean }>(
    `SELECT
       m.user_id,
       u.discord_id,
       (r.user_id IS NOT NULL) AS has_responded
     FROM group_membership m
     JOIN app_user u ON u.id = m.user_id
     LEFT JOIN weekly_response r
       ON r.user_id = m.user_id
      AND r.group_id = m.group_id
      AND r.week_start_date = $2
     WHERE m.group_id = $1
     ORDER BY has_responded ASC, m.user_id ASC`,
    [params.groupId, params.weekStartDate],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    discordId: row.discord_id,
    hasResponded: row.has_responded,
  }));
}
