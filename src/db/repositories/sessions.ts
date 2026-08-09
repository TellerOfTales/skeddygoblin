import type { Queryable } from '../pool.js';
import type { IsoDate } from '../../domain/week.js';
import type { Day, Window } from '../../domain/constants.js';
import type { GroupId, UserId } from './types.js';

export type ProposalStatus = 'proposed' | 'voting' | 'confirmed' | 'cancelled';
export type AttendanceResponse = 'yes' | 'maybe' | 'no';

export interface ProposalRecord {
  id: number;
  groupId: GroupId;
  weekStartDate: IsoDate;
  candidateDay: Day;
  candidateWindow: Window;
  status: ProposalStatus;
  messageId: string | null;
}

interface ProposalRow {
  id: number;
  group_id: number;
  week_start_date: string;
  candidate_day: number;
  candidate_window: Window;
  status: ProposalStatus;
  message_id: string | null;
}

function toRecord(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    weekStartDate: row.week_start_date,
    candidateDay: row.candidate_day as Day,
    candidateWindow: row.candidate_window,
    status: row.status,
    messageId: row.message_id,
  };
}

const COLUMNS =
  'id, group_id, week_start_date, candidate_day, candidate_window, status, message_id';

/**
 * Creates a proposal, or returns the existing one for that exact slot.
 *
 * The unique constraint on (group, week, day, window) is what makes two
 * organizers tapping "Lock in Wednesday evening" at once produce one session
 * rather than two.
 */
export async function createProposal(
  db: Queryable,
  params: {
    groupId: GroupId;
    weekStartDate: IsoDate;
    candidateDay: Day;
    candidateWindow: Window;
    createdBy: UserId | null;
  },
): Promise<ProposalRecord> {
  const result = await db.query<ProposalRow>(
    `INSERT INTO session_proposal
       (group_id, week_start_date, candidate_day, candidate_window, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (group_id, week_start_date, candidate_day, candidate_window)
     DO UPDATE SET status = session_proposal.status
     RETURNING ${COLUMNS}`,
    [
      params.groupId,
      params.weekStartDate,
      params.candidateDay,
      params.candidateWindow,
      params.createdBy,
    ],
  );
  return toRecord(result.rows[0]!);
}

export async function findProposalById(db: Queryable, id: number): Promise<ProposalRecord | null> {
  const result = await db.query<ProposalRow>(
    `SELECT ${COLUMNS} FROM session_proposal WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function setProposalStatus(
  db: Queryable,
  id: number,
  status: ProposalStatus,
): Promise<ProposalRecord> {
  const result = await db.query<ProposalRow>(
    `UPDATE session_proposal SET status = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, status],
  );
  return toRecord(result.rows[0]!);
}

export async function setProposalMessageId(
  db: Queryable,
  id: number,
  messageId: string,
): Promise<void> {
  await db.query(`UPDATE session_proposal SET message_id = $2 WHERE id = $1`, [id, messageId]);
}

export async function listProposalsForWeek(
  db: Queryable,
  params: { groupId: GroupId; weekStartDate: IsoDate },
): Promise<ProposalRecord[]> {
  const result = await db.query<ProposalRow>(
    `SELECT ${COLUMNS} FROM session_proposal
     WHERE group_id = $1 AND week_start_date = $2
     ORDER BY candidate_day, candidate_window`,
    [params.groupId, params.weekStartDate],
  );
  return result.rows.map(toRecord);
}

export async function setAttendance(
  db: Queryable,
  proposalId: number,
  userId: UserId,
  response: AttendanceResponse,
): Promise<void> {
  await db.query(
    `INSERT INTO session_attendance (proposal_id, user_id, response)
     VALUES ($1, $2, $3)
     ON CONFLICT (proposal_id, user_id)
     DO UPDATE SET response = EXCLUDED.response, responded_at = now()`,
    [proposalId, userId, response],
  );
}

/**
 * RSVP tallies. Counts only - the public message shows "4 yes · 1 maybe", never
 * who said what, which keeps it consistent with the aggregate-only rule.
 */
export async function countAttendanceAggregate(
  db: Queryable,
  proposalId: number,
): Promise<Record<AttendanceResponse, number>> {
  const result = await db.query<{ response: AttendanceResponse; count: number }>(
    `SELECT response, COUNT(*)::bigint AS count
     FROM session_attendance WHERE proposal_id = $1
     GROUP BY response`,
    [proposalId],
  );

  const counts: Record<AttendanceResponse, number> = { yes: 0, maybe: 0, no: 0 };
  for (const row of result.rows) counts[row.response] = row.count;
  return counts;
}

/** Ids of everyone who said yes, so they can be notified on confirmation. */
export async function listYesUserIds(db: Queryable, proposalId: number): Promise<UserId[]> {
  const result = await db.query<{ user_id: number }>(
    `SELECT user_id FROM session_attendance
     WHERE proposal_id = $1 AND response = 'yes' ORDER BY user_id`,
    [proposalId],
  );
  return result.rows.map((row) => row.user_id);
}

/** A member's own RSVP, so the buttons can show their current choice. */
export async function getAttendanceForSelf(
  db: Queryable,
  selfUserId: UserId,
  proposalId: number,
): Promise<AttendanceResponse | null> {
  const result = await db.query<{ response: AttendanceResponse }>(
    `SELECT response FROM session_attendance WHERE proposal_id = $1 AND user_id = $2`,
    [proposalId, selfUserId],
  );
  return result.rows[0]?.response ?? null;
}
