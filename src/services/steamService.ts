/**
 * Steam account linking and library sync.
 */

import { optionalSteamConfig } from '../config.js';
import { DomainError } from '../domain/errors.js';
import * as steam from '../db/repositories/steam.js';
import * as users from '../db/repositories/users.js';
import {
  fetchAppMeta,
  fetchOwnedGames,
  sleep,
  SteamProfilePrivateError,
  STORE_REQUEST_DELAY_MS,
} from '../steam/clients.js';
import { buildAuthUrl } from '../steam/openid.js';
import type { UserId } from '../db/repositories/types.js';
import type { AppContext } from './context.js';

/** How long app facts are trusted. Genres and categories rarely change. */
const APP_META_TTL_DAYS = 90;

/** Prices change with sales, so they go stale much faster than facts do. */
const APP_PRICE_TTL_DAYS = 3;

/**
 * The global per-tick request budget for the Steam Store endpoint.
 *
 * Steam allows roughly 200 requests per 5 minutes PER KEY, and there is one key
 * for every server this bot is in. At a 60s tick that is ~40 requests of
 * headroom; 30 leaves room for the interactive path (/propose does a live store
 * search) to not be starved by background work.
 */
const STORE_REQUESTS_PER_TICK = 30;

/** Of that budget, how much goes to facts before prices get the remainder. */
const STORE_FACTS_PER_TICK = 15;

export function steamEnabled(): boolean {
  return optionalSteamConfig() !== undefined;
}

function requireSteam(): { apiKey: string; publicBaseUrl: string } {
  const config = optionalSteamConfig();
  if (!config) {
    throw new DomainError('INVALID_INPUT', 'Steam is not configured on this deployment');
  }
  return config;
}

/** A one-time link URL. The state token is single-use and expires in 30 minutes. */
export async function beginLink(ctx: AppContext, userId: UserId): Promise<string> {
  const config = requireSteam();
  const state = await steam.createLinkState(ctx.db, userId);

  const returnTo = new URL('/steam/callback', config.publicBaseUrl);
  returnTo.searchParams.set('state', state);

  return buildAuthUrl({ returnTo: returnTo.toString(), realm: config.publicBaseUrl });
}

export interface LinkOutcome {
  userId: UserId;
  steamId: string;
  profilePublic: boolean;
  gamesSynced: number;
}

/**
 * Completes a link after Steam's assertion has been verified.
 *
 * Probes the library immediately so a private profile is reported at link time,
 * with an actionable message, rather than surfacing later as a mysteriously
 * empty shared-library list.
 */
export async function completeLink(
  ctx: AppContext,
  params: { state: string; steamId: string },
): Promise<LinkOutcome> {
  const userId = await steam.consumeLinkState(ctx.db, params.state);
  if (userId === null) {
    throw new DomainError('INVALID_INPUT', 'That link has already been used or has expired');
  }

  let profilePublic = true;
  let gamesSynced = 0;

  try {
    gamesSynced = await syncLibrary(ctx, userId, params.steamId);
  } catch (error) {
    if (error instanceof SteamProfilePrivateError) profilePublic = false;
    else throw error;
  }

  await steam.setSteamId(ctx.db, userId, params.steamId, profilePublic);
  return { userId, steamId: params.steamId, profilePublic, gamesSynced };
}

/** Replaces a member's cached library. Throws SteamProfilePrivateError if hidden. */
export async function syncLibrary(
  ctx: AppContext,
  userId: UserId,
  steamId?: string,
): Promise<number> {
  const config = requireSteam();

  let resolvedSteamId = steamId;
  if (!resolvedSteamId) {
    const user = await users.findUserById(ctx.db, userId);
    if (!user?.steamId) throw new DomainError('STEAM_NOT_LINKED');
    resolvedSteamId = user.steamId;
  }

  const games = await fetchOwnedGames({ apiKey: config.apiKey, steamId: resolvedSteamId });
  await steam.replaceLibraryForSelf(ctx.db, userId, games);

  ctx.logger.info('steam library synced', { userId, games: games.length });
  return games.length;
}

/**
 * Fills in metadata for apps the group owns but we know nothing about.
 *
 * Rate limited and bounded per run: the Store endpoint allows roughly 200
 * requests per 5 minutes, and there is no deadline here that justifies risking
 * a block.
 */
/**
 * Fills in the COUNTRY-INDEPENDENT facts about an app: name, genres,
 * categories, multiplayer. Fetched once per app, ever.
 *
 * Splitting facts from prices is what makes this survive 200 servers. Facts do
 * not vary by storefront, so a hundred groups owning the same game cost one
 * request between them - where the old country-flavoured refresh re-fetched
 * everything for whichever country won the tick.
 */
export async function refreshAppMetadata(
  ctx: AppContext,
  options: { limit?: number } = {},
): Promise<number> {
  requireSteam();

  const appIds = await steam.listAppIdsNeedingMeta(ctx.db, {
    limit: options.limit ?? STORE_FACTS_PER_TICK,
    staleAfterDays: APP_META_TTL_DAYS,
  });

  let fetched = 0;
  for (const appId of appIds) {
    try {
      // 'US' is arbitrary here - we keep only the facts, and discard the price
      // it happens to come with. Prices are refreshPrices' job.
      const meta = await fetchAppMeta(appId, { countryCode: 'US' });
      if (meta) {
        await steam.upsertAppMeta(ctx.db, meta);
        // Not wasted: the response already carried the US price, and US is
        // always needed as the reference figure shown in brackets.
        await steam.upsertAppPrice(ctx.db, {
          appId,
          countryCode: 'US',
          priceCents: meta.priceCents,
          currency: meta.currency,
        });
        fetched++;
      }
    } catch (error) {
      // One unavailable app must not abandon the rest of the batch.
      ctx.logger.warn('app metadata fetch failed', { appId, error });
    }
    await sleep(STORE_REQUEST_DELAY_MS);
  }

  if (fetched > 0) ctx.logger.info('app metadata refreshed', { fetched });
  return fetched;
}

/**
 * Refreshes prices for one storefront, within a budget.
 *
 * The budget is the whole point. The Steam Store endpoint allows roughly 200
 * requests per 5 minutes PER KEY, and there is one key for every server this
 * bot is in. Without a cap, one group with a huge library starves everyone
 * else; with one, the work is bounded and the worst case is a price that says
 * nothing yet rather than a bot that has been blocked.
 */
export async function refreshPrices(
  ctx: AppContext,
  params: { countryCode: string; budget: number },
): Promise<number> {
  requireSteam();
  if (params.budget <= 0) return 0;

  const appIds = await steam.listAppIdsNeedingPrice(ctx.db, {
    countryCode: params.countryCode,
    limit: params.budget,
    staleAfterDays: APP_PRICE_TTL_DAYS,
  });

  let fetched = 0;
  for (const appId of appIds) {
    try {
      const meta = await fetchAppMeta(appId, { countryCode: params.countryCode });
      // A null row is still written: it records that we asked and Steam had
      // nothing, which stops this app being retried every single tick forever.
      await steam.upsertAppPrice(ctx.db, {
        appId,
        countryCode: params.countryCode,
        priceCents: meta?.priceCents ?? null,
        currency: meta?.currency ?? null,
      });
      fetched++;
    } catch (error) {
      ctx.logger.warn('price fetch failed', { appId, country: params.countryCode, error });
    }
    await sleep(STORE_REQUEST_DELAY_MS);
  }

  return fetched;
}

/**
 * One pass of Steam catalogue work, spending a fixed global budget.
 *
 * Facts first, because an app with no facts cannot be suggested at all - its
 * multiplayer flag defaults to false. Whatever is left is split evenly between
 * the storefronts actually in use, so no country can starve another however
 * many groups are on it.
 */
export async function refreshSteamCatalogue(ctx: AppContext): Promise<void> {
  const facts = await refreshAppMetadata(ctx);

  const remaining = STORE_REQUESTS_PER_TICK - facts;
  if (remaining <= 0) return;

  const countries = await steam.listActiveCountryCodesAggregate(ctx.db);
  if (countries.length === 0) return;

  // Fair share, floor at 1 so a long country list still makes progress rather
  // than every share rounding to zero.
  const perCountry = Math.max(1, Math.floor(remaining / countries.length));

  let spent = 0;
  for (const countryCode of countries) {
    if (spent >= remaining) break;
    spent += await refreshPrices(ctx, {
      countryCode,
      budget: Math.min(perCountry, remaining - spent),
    });
  }

  if (spent > 0) {
    ctx.logger.info('prices refreshed', { countries: countries.length, fetched: spent });
  }
}

export interface GroupSyncOutcome {
  synced: number;
  private: number;
  failed: number;
}

/**
 * Re-syncs every linked member's library in a group.
 *
 * Libraries go stale - people buy games. Without this, the shared-library view
 * would only ever reflect what someone owned on the day they linked.
 *
 * A member whose profile has since gone private is recorded as such rather than
 * silently dropped, so `/link-steam` can tell them why they vanished from the
 * group's shared list.
 */
export async function syncGroupLibraries(
  ctx: AppContext,
  groupId: number,
): Promise<GroupSyncOutcome> {
  const outcome: GroupSyncOutcome = { synced: 0, private: 0, failed: 0 };
  if (!steamEnabled()) return outcome;

  const linked = await steam.listLinkedUserIds(ctx.db, groupId);

  for (const userId of linked) {
    try {
      await syncLibrary(ctx, userId);
      await steam.setSteamPublic(ctx.db, userId, true);
      outcome.synced++;
    } catch (error) {
      if (error instanceof SteamProfilePrivateError) {
        await steam.setSteamPublic(ctx.db, userId, false);
        outcome.private++;
      } else {
        // One member's failure must not abandon the rest of the group.
        ctx.logger.warn('library sync failed for member', { userId, error });
        outcome.failed++;
      }
    }
  }

  if (linked.length > 0) ctx.logger.info('group libraries synced', { groupId, ...outcome });
  return outcome;
}

/** A member's own library. Self-scoped. */
export async function getOwnLibrary(ctx: AppContext, userId: UserId) {
  return steam.listLibraryForSelf(ctx.db, userId);
}
