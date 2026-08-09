import type { Queryable } from '../pool.js';
import type { UserId, UserRecord } from './types.js';
import type { PreferredChannel } from '../../notify/Notifier.js';

interface UserRow {
  id: number;
  discord_id: string;
  steam_id: string | null;
  steam_public: boolean;
  timezone: string;
  preferred_channel: PreferredChannel;
  phone_e164: string | null;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    discordId: row.discord_id,
    steamId: row.steam_id,
    steamPublic: row.steam_public,
    timezone: row.timezone,
    preferredChannel: row.preferred_channel,
    phoneE164: row.phone_e164,
  };
}

const COLUMNS = 'id, discord_id, steam_id, steam_public, timezone, preferred_channel, phone_e164';

/**
 * Upserts by Discord snowflake. Called on the first interaction of any kind, so
 * there is never a "user not found" path in the flows themselves.
 */
export async function ensureUser(
  db: Queryable,
  discordId: string,
  defaults: { timezone: string },
): Promise<UserRecord> {
  const result = await db.query<UserRow>(
    `INSERT INTO app_user (discord_id, timezone)
     VALUES ($1, $2)
     ON CONFLICT (discord_id) DO UPDATE SET updated_at = now()
     RETURNING ${COLUMNS}`,
    [discordId, defaults.timezone],
  );
  return toRecord(result.rows[0]!);
}

export async function findUserById(db: Queryable, id: UserId): Promise<UserRecord | null> {
  const result = await db.query<UserRow>(`SELECT ${COLUMNS} FROM app_user WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function findUserByDiscordId(
  db: Queryable,
  discordId: string,
): Promise<UserRecord | null> {
  const result = await db.query<UserRow>(`SELECT ${COLUMNS} FROM app_user WHERE discord_id = $1`, [
    discordId,
  ]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** Bulk fetch for notification fan-out. Identity only, no preferences. */
export async function listUsersByIds(db: Queryable, ids: UserId[]): Promise<UserRecord[]> {
  if (ids.length === 0) return [];
  const result = await db.query<UserRow>(
    `SELECT ${COLUMNS} FROM app_user WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [ids],
  );
  return result.rows.map(toRecord);
}
