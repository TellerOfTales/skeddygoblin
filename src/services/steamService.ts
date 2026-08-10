/**
 * Steam account linking and library sync.
 */

import { optionalSteamConfig } from '../config.js';
import { DomainError } from '../domain/errors.js';
import * as steam from '../db/repositories/steam.js';
import * as users from '../db/repositories/users.js';
import {
  fetchAppMetaWithUsd,
  fetchOwnedGames,
  sleep,
  SteamProfilePrivateError,
  STORE_REQUEST_DELAY_MS,
} from '../steam/clients.js';
import { buildAuthUrl } from '../steam/openid.js';
import type { UserId } from '../db/repositories/types.js';
import type { AppContext } from './context.js';

/** How long app metadata is trusted before being refetched. */
const APP_META_TTL_DAYS = 30;

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
export async function refreshAppMetadata(
  ctx: AppContext,
  options: { limit?: number; countryCode?: string } = {},
): Promise<number> {
  requireSteam();

  // Which storefront the cached price describes. Defaults to US, which is also
  // what makes the bracketed reference price free in that case.
  const countryCode = (options.countryCode ?? 'US').toUpperCase();

  const appIds = await steam.listAppIdsNeedingMeta(ctx.db, {
    limit: options.limit ?? 40,
    staleAfterDays: APP_META_TTL_DAYS,
  });

  let fetched = 0;
  for (const appId of appIds) {
    try {
      const meta = await fetchAppMetaWithUsd(appId, countryCode);
      if (meta) {
        await steam.upsertAppMeta(ctx.db, meta);
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
