import type { Queryable } from '../pool.js';
import type { GroupId, MembershipRecord, MembershipRole, UserId } from './types.js';

interface MembershipRow {
  user_id: number;
  group_id: number;
  role: MembershipRole;
}

function toRecord(row: MembershipRow): MembershipRecord {
  return { userId: row.user_id, groupId: row.group_id, role: row.role };
}

/**
 * Membership is opt-in, not derived from the guild member list.
 *
 * That is a deliberate choice: fetching guild members needs the privileged
 * GUILD_MEMBERS intent, and the resulting roster would list everyone who ever
 * joined the server rather than the people who actually play.
 */
export async function ensureMembership(
  db: Queryable,
  userId: UserId,
  groupId: GroupId,
  role: MembershipRole = 'member',
): Promise<MembershipRecord> {
  const result = await db.query<MembershipRow>(
    `INSERT INTO group_membership (user_id, group_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, group_id) DO UPDATE SET role = group_membership.role
     RETURNING user_id, group_id, role`,
    [userId, groupId, role],
  );
  return toRecord(result.rows[0]!);
}

export async function findMembership(
  db: Queryable,
  userId: UserId,
  groupId: GroupId,
): Promise<MembershipRecord | null> {
  const result = await db.query<MembershipRow>(
    `SELECT user_id, group_id, role FROM group_membership WHERE user_id = $1 AND group_id = $2`,
    [userId, groupId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function isMember(db: Queryable, userId: UserId, groupId: GroupId): Promise<boolean> {
  return (await findMembership(db, userId, groupId)) !== null;
}

export async function isOrganizer(
  db: Queryable,
  userId: UserId,
  groupId: GroupId,
): Promise<boolean> {
  const membership = await findMembership(db, userId, groupId);
  return membership?.role === 'organizer';
}

export async function setRole(
  db: Queryable,
  userId: UserId,
  groupId: GroupId,
  role: MembershipRole,
): Promise<void> {
  await db.query(`UPDATE group_membership SET role = $3 WHERE user_id = $1 AND group_id = $2`, [
    userId,
    groupId,
    role,
  ]);
}

/** Member ids only. No preference data, so this is safe for any caller. */
export async function listMemberIds(db: Queryable, groupId: GroupId): Promise<UserId[]> {
  const result = await db.query<{ user_id: number }>(
    `SELECT user_id FROM group_membership WHERE group_id = $1 ORDER BY user_id`,
    [groupId],
  );
  return result.rows.map((row) => row.user_id);
}

export async function countMembers(db: Queryable, groupId: GroupId): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT COUNT(*)::bigint AS count FROM group_membership WHERE group_id = $1`,
    [groupId],
  );
  return result.rows[0]?.count ?? 0;
}
