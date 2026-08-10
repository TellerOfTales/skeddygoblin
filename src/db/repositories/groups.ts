import type { Queryable } from '../pool.js';
import type { GroupId, GroupRecord } from './types.js';
import type { Day } from '../../domain/constants.js';

interface GroupRow {
  id: number;
  discord_guild_id: string;
  name: string;
  timezone: string;
  country_code: string;
  announce_channel_id: string | null;
  nudge_cutoff_day: number;
  nudge_cutoff_time: string;
}

function toRecord(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    discordGuildId: row.discord_guild_id,
    name: row.name,
    timezone: row.timezone,
    countryCode: row.country_code,
    announceChannelId: row.announce_channel_id,
    nudgeCutoffDay: row.nudge_cutoff_day as Day,
    nudgeCutoffTime: row.nudge_cutoff_time,
  };
}

const COLUMNS =
  'id, discord_guild_id, name, timezone, country_code, announce_channel_id, nudge_cutoff_day, nudge_cutoff_time';

export async function ensureGroup(
  db: Queryable,
  discordGuildId: string,
  defaults: { name: string; timezone: string; announceChannelId?: string | undefined },
): Promise<GroupRecord> {
  const result = await db.query<GroupRow>(
    `INSERT INTO app_group (discord_guild_id, name, timezone, announce_channel_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (discord_guild_id) DO UPDATE SET updated_at = now()
     RETURNING ${COLUMNS}`,
    [discordGuildId, defaults.name, defaults.timezone, defaults.announceChannelId ?? null],
  );
  return toRecord(result.rows[0]!);
}

export async function findGroupById(db: Queryable, id: GroupId): Promise<GroupRecord | null> {
  const result = await db.query<GroupRow>(`SELECT ${COLUMNS} FROM app_group WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function findGroupByGuildId(
  db: Queryable,
  discordGuildId: string,
): Promise<GroupRecord | null> {
  const result = await db.query<GroupRow>(
    `SELECT ${COLUMNS} FROM app_group WHERE discord_guild_id = $1`,
    [discordGuildId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function listAllGroups(db: Queryable): Promise<GroupRecord[]> {
  const result = await db.query<GroupRow>(`SELECT ${COLUMNS} FROM app_group ORDER BY id`);
  return result.rows.map(toRecord);
}

export async function updateGroupSettings(
  db: Queryable,
  id: GroupId,
  settings: {
    timezone?: string;
    countryCode?: string;
    announceChannelId?: string | null;
    nudgeCutoffDay?: Day;
    nudgeCutoffTime?: string;
  },
): Promise<GroupRecord> {
  const result = await db.query<GroupRow>(
    `UPDATE app_group SET
       timezone            = COALESCE($2, timezone),
       announce_channel_id = COALESCE($3, announce_channel_id),
       nudge_cutoff_day    = COALESCE($4, nudge_cutoff_day),
       nudge_cutoff_time   = COALESCE($5, nudge_cutoff_time),
       country_code        = COALESCE($6, country_code),
       updated_at          = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      id,
      settings.timezone ?? null,
      settings.announceChannelId ?? null,
      settings.nudgeCutoffDay ?? null,
      settings.nudgeCutoffTime ?? null,
      settings.countryCode ?? null,
    ],
  );
  return toRecord(result.rows[0]!);
}
