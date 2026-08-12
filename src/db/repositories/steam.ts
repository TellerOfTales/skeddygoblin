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
/**
 * Which apps to fetch metadata for next, MOST SHARED FIRST.
 *
 * The order matters more than it looks. This used to be `ORDER BY app_id`,
 * which is chronological by Steam release - so every game from 2004 was fetched
 * before anything from this year, and the recent co-op titles a group actually
 * wants to play sat at the very back of a queue thousands of apps long. Since a
 * game with no metadata is invisible to the suggester entirely (its multiplayer
 * flag defaults to false), those games could not be suggested at all until the
 * backlog drained.
 *
 * Owner count first: a game six of you own is worth knowing about before one
 * only one person has. Newest first as the tiebreak, because that is where the
 * games people are currently talking about live.
 */
export async function listAppIdsNeedingMeta(
  db: Queryable,
  params: { limit: number; staleAfterDays: number },
): Promise<number[]> {
  const result = await db.query<{ app_id: number }>(
    `SELECT c.app_id
     FROM steam_library_cache c
     LEFT JOIN steam_app_meta m ON m.app_id = c.app_id
     WHERE m.app_id IS NULL
        OR m.fetched_at < now() - ($2 || ' days')::interval
     GROUP BY c.app_id
     ORDER BY COUNT(*) DESC, c.app_id DESC
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
    /** The group's storefront. Prices come from it; USD comes alongside. */
    countryCode?: string;
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
       local.price_cents,
       local.currency,
       usd.price_cents AS price_cents_usd,
       $6::text        AS price_country,
       m.store_url,
       COUNT(*)::bigint AS owner_count
     FROM steam_library_cache c
     JOIN weekly_response r
       ON r.user_id = c.user_id
      AND r.group_id = $1
      AND r.week_start_date = $2
      AND r.status = 'submitted'
     LEFT JOIN steam_app_meta m ON m.app_id = c.app_id
     -- Priced per storefront: one row per (app, country), so two groups in two
     -- countries see two different real prices rather than sharing one.
     LEFT JOIN steam_app_price local ON local.app_id = c.app_id AND local.country_code = $6
     LEFT JOIN steam_app_price usd   ON usd.app_id   = c.app_id AND usd.country_code = 'US'
     WHERE ($4::boolean IS NOT TRUE)
        OR COALESCE(m.multiplayer, c.multiplayer) IS TRUE
     GROUP BY m.app_id, c.app_id, m.name, m.categories, m.genres, m.multiplayer,
              local.price_cents, local.currency, usd.price_cents, m.store_url
     HAVING COUNT(*) >= $3
     ORDER BY owner_count DESC, name ASC
     LIMIT $5`,
    [
      params.groupId,
      params.weekStartDate,
      params.minOwners,
      params.multiplayerOnly ?? false,
      params.limit ?? 50,
      (params.countryCode ?? 'US').toUpperCase(),
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

/**
 * How many members have not linked Steam. A COUNT, never a list of names.
 *
 * "3 of you have not linked Steam" is an aggregate the group can act on;
 * "Dana has not linked Steam" would single someone out on a public board for
 * having done nothing wrong.
 */
export async function countUnlinkedMembersAggregate(
  db: Queryable,
  groupId: GroupId,
): Promise<{ unlinked: number; total: number }> {
  const result = await db.query<{ unlinked: string; total: string }>(
    `SELECT COUNT(*) FILTER (WHERE u.steam_id IS NULL)::bigint AS unlinked,
            COUNT(*)::bigint AS total
       FROM group_membership m
       JOIN app_user u ON u.id = m.user_id
      WHERE m.group_id = $1`,
    [groupId],
  );
  const row = result.rows[0];
  return { unlinked: Number(row?.unlinked ?? 0), total: Number(row?.total ?? 0) };
}

// ---------------------------------------------------------------------------
// Per-country prices
// ---------------------------------------------------------------------------

export async function upsertAppPrice(
  db: Queryable,
  params: {
    appId: number;
    countryCode: string;
    priceCents: number | null;
    currency: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO steam_app_price (app_id, country_code, price_cents, currency)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id, country_code) DO UPDATE SET
       price_cents = EXCLUDED.price_cents,
       currency    = EXCLUDED.currency,
       fetched_at  = now()`,
    [params.appId, params.countryCode.toUpperCase(), params.priceCents, params.currency],
  );
}

/**
 * Apps that have facts but no fresh price for this storefront.
 *
 * Ordered by how many people across ALL groups own it, so a budget too small to
 * cover everything spends itself on the games most likely to be suggested.
 */
export async function listAppIdsNeedingPrice(
  db: Queryable,
  params: { countryCode: string; limit: number; staleAfterDays: number },
): Promise<number[]> {
  const result = await db.query<{ app_id: number }>(
    `SELECT m.app_id
       FROM steam_app_meta m
       JOIN steam_library_cache c ON c.app_id = m.app_id
       LEFT JOIN steam_app_price p
         ON p.app_id = m.app_id AND p.country_code = $1
      WHERE p.app_id IS NULL
         OR p.fetched_at < now() - ($3 || ' days')::interval
      GROUP BY m.app_id
      ORDER BY COUNT(*) DESC, m.app_id DESC
      LIMIT $2`,
    [params.countryCode.toUpperCase(), params.limit, String(params.staleAfterDays)],
  );
  return result.rows.map((row) => row.app_id);
}

/** Distinct storefronts actually in use. The unit of per-country work. */
export async function listActiveCountryCodesAggregate(db: Queryable): Promise<string[]> {
  const result = await db.query<{ country_code: string }>(
    `SELECT DISTINCT country_code FROM app_group ORDER BY country_code`,
  );
  const codes = result.rows.map((row) => row.country_code);
  // US is always worked, because it is the reference price shown in brackets
  // everywhere - even for groups that are not on it.
  return codes.includes('US') ? codes : [...codes, 'US'];
}
