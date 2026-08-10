/**
 * The two Steam surfaces we read.
 *
 * They have very different characteristics, which is why they are used very
 * differently:
 *
 *   - IPlayerService/GetOwnedGames is keyed, per-user, and requires the
 *     profile's game details to be public. One call per member per sync.
 *   - store.steampowered.com/api/appdetails is unkeyed, per-APP, and rate
 *     limited at roughly 200 requests per 5 minutes. It is called once per
 *     distinct app across the whole group and cached in steam_app_meta - which
 *     is the difference between eight members costing eight calls and costing
 *     one.
 */

import { isMultiplayer } from '../domain/gameMatching.js';
import type { AppMeta, OwnedGame } from '../db/repositories/steam.js';

const PLAYER_SERVICE = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/';
const STORE_APPDETAILS = 'https://store.steampowered.com/api/appdetails';

export class SteamProfilePrivateError extends Error {
  constructor() {
    super('Steam profile game details are not public');
    this.name = 'SteamProfilePrivateError';
  }
}

interface OwnedGamesResponse {
  response?: {
    game_count?: number;
    games?: Array<{ appid: number; name?: string }>;
  };
}

/**
 * A member's owned games.
 *
 * A private profile returns `{ response: {} }` with HTTP 200 rather than an
 * error, so "no games key at all" is the signal - distinguished from a genuinely
 * empty library, which returns game_count: 0.
 */
export async function fetchOwnedGames(
  params: { apiKey: string; steamId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OwnedGame[]> {
  const url = new URL(PLAYER_SERVICE);
  url.searchParams.set('key', params.apiKey);
  url.searchParams.set('steamid', params.steamId);
  url.searchParams.set('include_appinfo', '1');
  url.searchParams.set('include_played_free_games', '1');

  const response = await fetchImpl(url.toString());
  if (!response.ok) throw new Error(`GetOwnedGames returned ${response.status}`);

  const body = (await response.json()) as OwnedGamesResponse;

  if (!body.response || body.response.games === undefined) {
    if (body.response?.game_count === 0) return [];
    throw new SteamProfilePrivateError();
  }

  return body.response.games
    .filter((game) => typeof game.name === 'string' && game.name.length > 0)
    .map((game) => ({
      appId: game.appid,
      gameName: game.name!,
      // Refined by app metadata later; the library endpoint says nothing about
      // multiplayer, so assume nothing here.
      multiplayer: false,
    }));
}

interface AppDetailsResponse {
  [appId: string]: {
    success: boolean;
    data?: {
      name?: string;
      categories?: Array<{ description?: string }>;
      genres?: Array<{ description?: string }>;
      price_overview?: { final?: number; currency?: string };
      is_free?: boolean;
    };
  };
}

/**
 * Metadata for one app. Returns null for apps Steam will not describe -
 * delisted titles, region-locked ones, and most non-game software.
 */
export async function fetchAppMeta(
  appId: number,
  options: { countryCode?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<AppMeta | null> {
  const url = new URL(STORE_APPDETAILS);
  url.searchParams.set('appids', String(appId));
  url.searchParams.set('cc', options.countryCode ?? 'us');
  url.searchParams.set('l', 'english');

  const response = await fetchImpl(url.toString());
  if (!response.ok) throw new Error(`appdetails returned ${response.status}`);

  const body = (await response.json()) as AppDetailsResponse;
  const entry = body[String(appId)];
  if (!entry?.success || !entry.data) return null;

  const categories = (entry.data.categories ?? [])
    .map((category) => category.description)
    .filter((description): description is string => typeof description === 'string');
  const genres = (entry.data.genres ?? [])
    .map((genre) => genre.description)
    .filter((description): description is string => typeof description === 'string');

  return {
    appId,
    name: entry.data.name ?? `App ${appId}`,
    categories,
    genres,
    multiplayer: isMultiplayer(categories),
    priceCents: entry.data.is_free ? 0 : (entry.data.price_overview?.final ?? null),
    currency: entry.data.price_overview?.currency ?? null,
    priceCountry: (options.countryCode ?? 'US').toUpperCase(),
    priceCentsUsd: null,
    storeUrl: `https://store.steampowered.com/app/${appId}`,
  };
}

/**
 * Metadata priced in the group's storefront, plus the US price for reference.
 *
 * Two calls, not one, because Steam prices regionally and there is no
 * conversion that would give the same answer - a US price is a fact about the
 * US storefront, not a currency-converted local price. The second call is
 * skipped when the group already IS on the US storefront, which is both the
 * common case for the default config and the one where brackets would be
 * meaningless.
 */
export async function fetchAppMetaWithUsd(
  appId: number,
  countryCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppMeta | null> {
  const local = await fetchAppMeta(appId, { countryCode }, fetchImpl);
  if (!local) return null;

  if (local.priceCountry === 'US') return { ...local, priceCentsUsd: local.priceCents };

  await sleep(STORE_REQUEST_DELAY_MS);

  try {
    const usd = await fetchAppMeta(appId, { countryCode: 'US' }, fetchImpl);
    return { ...local, priceCentsUsd: usd?.priceCents ?? null };
  } catch {
    // A missing reference price is a cosmetic loss - the local price, which is
    // the one that matters, is already in hand. Never fail the whole app over
    // the bracketed figure.
    return local;
  }
}

/** Politeness delay between Store API calls. See the rate limit note above. */
export const STORE_REQUEST_DELAY_MS = 1_500;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Store search - for games nobody in the group owns yet
// ---------------------------------------------------------------------------

export interface StoreSearchResult {
  appId: number;
  name: string;
  priceCents: number | null;
  currency: string | null;
  storeUrl: string;
}

interface StoreSearchResponse {
  total?: number;
  items?: Array<{
    id?: number;
    name?: string;
    price?: { currency?: string; initial?: number; final?: number };
  }>;
}

/**
 * Searches the Steam store by name, in a given storefront.
 *
 * This is what makes a free-text /propose useful: someone nominates a game
 * nobody owns yet, and the group immediately sees what it would cost THEM. The
 * `cc` parameter is why prices come back in the group's own currency rather
 * than dollars - Steam prices regionally, so a UK group asking for a US price
 * would get a misleading number.
 *
 * A game with no `price` object is free-to-play or unreleased; that is reported
 * as a null price rather than zero, because "we do not know" and "it costs
 * nothing" are different answers.
 */
export async function searchStore(
  params: { term: string; countryCode: string; limit?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<StoreSearchResult[]> {
  const term = params.term.trim();
  if (term.length === 0) return [];

  const url = new URL('https://store.steampowered.com/api/storesearch/');
  url.searchParams.set('term', term);
  url.searchParams.set('cc', params.countryCode);
  url.searchParams.set('l', 'english');

  const response = await fetchImpl(url.toString());
  if (!response.ok) throw new Error(`storesearch returned ${response.status}`);

  const body = (await response.json()) as StoreSearchResponse;

  return (body.items ?? [])
    .filter(
      (item): item is { id: number; name: string; price?: { currency?: string; final?: number } } =>
        typeof item.id === 'number' && typeof item.name === 'string',
    )
    .slice(0, params.limit ?? 10)
    .map((item) => ({
      appId: item.id,
      name: item.name,
      priceCents: typeof item.price?.final === 'number' ? item.price.final : null,
      currency: item.price?.currency ?? null,
      storeUrl: `https://store.steampowered.com/app/${item.id}`,
    }));
}
