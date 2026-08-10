import { randomBytes } from 'node:crypto';
import type { Queryable } from '../pool.js';
import type { GroupId, UserId } from './types.js';
import type { IsoDate } from '../../domain/week.js';

export interface OwnedGame {
  appId: number;
  gameName: string;
  multiplayer: boolean;
}

export interface AppMeta {
  appId: number;
  name: string;
  categories: string[];
  genres: string[];
  multiplayer: boolean;
  priceCents: number | null;
  currency: string | null;
  /** Storefront the local price came from, so a stale-country price is visible. */
  priceCountry: string | null;
  /** The US storefront's price, shown in brackets as a reference point. */
  priceCentsUsd: number | null;
  storeUrl: string | null;
}

/**
 * A shared game: how many members of the group own it, and never WHICH ones.
 *
 * "6 of you own this" is an aggregate. "Bob owns this" is a raw disclosure -
 * the same rule that governs availability applies to libraries.
 */
export interface SharedGame extends AppMeta {
  ownerCount: number;
}

// ---------------------------------------------------------------------------
// Per-user library
// ---------------------------------------------------------------------------

export async function replaceLibraryForSelf(
  db: Queryable,
  selfUserId: UserId,
  games: readonly OwnedGame[],
): Promise<number> {
  await db.query(`DELETE FROM steam_library_cache WHERE user_id = $1`, [selfUserId]);
  if (games.length === 0) return 0;

  const result = await db.query(
    `INSERT INTO steam_library_cache (user_id, app_id, game_name, multiplayer)
     SELECT $1, app_id, name, multi
     FROM unnest($2::int[], $3::text[], $4::boolean[]) AS t(app_id, name, multi)
     ON CONFLICT (user_id, app_id) DO UPDATE
       SET game_name = EXCLUDED.game_name,
           multiplayer = EXCLUDED.multiplayer,
           last_synced_at = now()`,
    [
      selfUserId,
      games.map((game) => game.appId),
      games.map((game) => game.gameName),
      games.map((game) => game.multiplayer),
    ],
  );
  return result.rowCount ?? 0;
}

export async function listLibraryForSelf(db: Queryable, selfUserId: UserId): Promise<OwnedGame[]> {
  const result = await db.query<{ app_id: number; game_name: string; multiplayer: boolean }>(
    `SELECT app_id, game_name, multiplayer FROM steam_library_cache
     WHERE user_id = $1 ORDER BY game_name`,
    [selfUserId],
  );
  return result.rows.map((row) => ({
    appId: row.app_id,
    gameName: row.game_name,
    multiplayer: row.multiplayer,
  }));
}

export async function lastSyncedAtForSelf(db: Queryable, selfUserId: UserId): Promise<Date | null> {
  const result = await db.query<{ last: Date | null }>(
    `SELECT MAX(last_synced_at) AS last FROM steam_library_cache WHERE user_id = $1`,
    [selfUserId],
  );
  return result.rows[0]?.last ?? null;
}

// ---------------------------------------------------------------------------
// Shared app metadata (not per-user, deliberately)
// ---------------------------------------------------------------------------

export async function upsertAppMeta(db: Queryable, meta: AppMeta): Promise<void> {
  await db.query(
    `INSERT INTO steam_app_meta
       (app_id, name, categories, genres, multiplayer, price_cents, currency,
        price_country, price_cents_usd, store_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (app_id) DO UPDATE SET
       name = EXCLUDED.name,
       categories = EXCLUDED.categories,
       genres = EXCLUDED.genres,
       multiplayer = EXCLUDED.multiplayer,
       price_cents = EXCLUDED.price_cents,
       currency = EXCLUDED.currency,
       price_country = EXCLUDED.price_country,
       price_cents_usd = EXCLUDED.price_cents_usd,
       store_url = EXCLUDED.store_url,
       fetched_at = now()`,
    [
      meta.appId,
      meta.name,
      meta.categories,
      meta.genres,
      meta.multiplayer,
      meta.priceCents,
      meta.currency,
      meta.priceCountry,
      meta.priceCentsUsd,
      meta.storeUrl,
    ],
  );
}

/** App ids we have no metadata for, or whose metadata has gone stale. */
export async function listAppIdsNeedingMeta(
  db: Queryable,
  params: { limit: number; staleAfterDays: number },
): Promise<number[]> {
  const result = await db.query<{ app_id: number }>(
    `SELECT DISTINCT c.app_id
     FROM steam_library_cache c
     LEFT JOIN steam_app_meta m ON m.app_id = c.app_id
     WHERE m.app_id IS NULL
        OR m.fetched_at < now() - ($2 || ' days')::interval
     ORDER BY c.app_id
     LIMIT $1`,
    [params.limit, String(params.staleAfterDays)],
  );
  return result.rows.map((row) => row.app_id);
}

// ---------------------------------------------------------------------------
// Group-level aggregate
// ---------------------------------------------------------------------------

/**
 * Games owned by at least `minOwners` members who submitted this week.
 *
 * Restricted to submitted responders on purpose: the point is what THIS week's
 * players can actually load up, not what the whole server owns. No user id
 * appears in the result.
 */
export async function listSharedGamesAggregate(
  db: Queryable,
  params: {
    groupId: GroupId;
    weekStartDate: IsoDate;
    minOwners: number;
    multiplayerOnly?: boolean;
    limit?: number;
  },
): Promise<SharedGame[]> {
  const result = await db.query<{
    app_id: number;
    name: string;
    categories: string[];
    genres: string[];
    multiplayer: boolean;
    price_cents: number | null;
    currency: string | null;
    price_cents_usd: number | null;
    price_country: string | null;
    store_url: string | null;
    owner_count: number;
  }>(
    `SELECT
       m.app_id,
       COALESCE(m.name, MIN(c.game_name)) AS name,
       COALESCE(m.categories, '{}') AS categories,
       COALESCE(m.genres, '{}') AS genres,
       COALESCE(m.multiplayer, bool_or(c.multiplayer)) AS multiplayer,
       m.price_cents,
       m.currency,
       m.price_cents_usd,
       m.price_country,
       m.store_url,
       COUNT(*)::bigint AS owner_count
     FROM steam_library_cache c
     JOIN weekly_response r
       ON r.user_id = c.user_id
      AND r.group_id = $1
      AND r.week_start_date = $2
      AND r.status = 'submitted'
     LEFT JOIN steam_app_meta m ON m.app_id = c.app_id
     WHERE ($4::boolean IS NOT TRUE)
        OR COALESCE(m.multiplayer, c.multiplayer) IS TRUE
     GROUP BY m.app_id, c.app_id, m.name, m.categories, m.genres, m.multiplayer,
              m.price_cents, m.currency, m.price_cents_usd, m.price_country, m.store_url
     HAVING COUNT(*) >= $3
     ORDER BY owner_count DESC, name ASC
     LIMIT $5`,
    [
      params.groupId,
      params.weekStartDate,
      params.minOwners,
      params.multiplayerOnly ?? false,
      params.limit ?? 50,
    ],
  );

  return result.rows.map((row) => ({
    appId: row.app_id,
    name: row.name,
    categories: row.categories ?? [],
    genres: row.genres ?? [],
    multiplayer: row.multiplayer,
    priceCents: row.price_cents,
    currency: row.currency,
    priceCentsUsd: row.price_cents_usd,
    priceCountry: row.price_country,
    storeUrl: row.store_url,
    ownerCount: row.owner_count,
  }));
}

// ---------------------------------------------------------------------------
// Account linking
// ---------------------------------------------------------------------------

export async function createLinkState(db: Queryable, userId: UserId): Promise<string> {
  const state = randomBytes(24).toString('base64url');
  await db.query(`INSERT INTO steam_link_state (state, user_id) VALUES ($1, $2)`, [state, userId]);
  return state;
}

/** Consumes a link token. Returns the user id, or null if already used. */
export async function consumeLinkState(db: Queryable, state: string): Promise<UserId | null> {
  const result = await db.query<{ user_id: number }>(
    `UPDATE steam_link_state SET consumed_at = now()
     WHERE state = $1
       AND consumed_at IS NULL
       AND created_at > now() - interval '30 minutes'
     RETURNING user_id`,
    [state],
  );
  return result.rows[0]?.user_id ?? null;
}

export async function setSteamId(
  db: Queryable,
  userId: UserId,
  steamId: string,
  steamPublic: boolean,
): Promise<void> {
  await db.query(
    `UPDATE app_user SET steam_id = $2, steam_public = $3, updated_at = now() WHERE id = $1`,
    [userId, steamId, steamPublic],
  );
}

export async function setSteamPublic(
  db: Queryable,
  userId: UserId,
  steamPublic: boolean,
): Promise<void> {
  await db.query(`UPDATE app_user SET steam_public = $2 WHERE id = $1`, [userId, steamPublic]);
}

/** Members of a group with a linked Steam account, for the sync job. */
export async function listLinkedUserIds(db: Queryable, groupId: GroupId): Promise<UserId[]> {
  const result = await db.query<{ id: number }>(
    `SELECT u.id
     FROM app_user u
     JOIN group_membership m ON m.user_id = u.id
     WHERE m.group_id = $1 AND u.steam_id IS NOT NULL
     ORDER BY u.id`,
    [groupId],
  );
  return result.rows.map((row) => row.id);
}
