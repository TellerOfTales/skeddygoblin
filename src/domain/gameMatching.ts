/**
 * Matching the group's shared library to the week's mood. Pure.
 *
 * The vibe tags are ours; Steam's categories and genres are theirs. This module
 * is the translation between the two, kept as data so it can be tuned without
 * touching query code.
 */

import type { VibeTag } from './constants.js';

/**
 * Steam store categories that mean "you can play this together".
 *
 * Taken from the appdetails `categories` list. Names rather than ids because
 * the ids are undocumented and have shifted historically, whereas the display
 * names have been stable.
 */
export const MULTIPLAYER_CATEGORIES = [
  'Multi-player',
  'Co-op',
  'Online Co-op',
  'Shared/Split Screen Co-op',
  'PvP',
  'Online PvP',
  'Shared/Split Screen PvP',
  'Cross-Platform Multiplayer',
  'LAN Co-op',
  'LAN PvP',
];

export function isMultiplayer(categories: readonly string[]): boolean {
  return categories.some((category) => MULTIPLAYER_CATEGORIES.includes(category));
}

/**
 * What each vibe is looking for.
 *
 * `any` matches if ANY listed genre/category is present; `none` rejects the
 * game if any listed term is present. A vibe with neither matches everything,
 * which is the right default for a mood that is about how people play rather
 * than what they play.
 */
export interface VibeFilter {
  anyGenres?: string[];
  anyCategories?: string[];
  noneGenres?: string[];
}

export const VIBE_FILTERS: Record<VibeTag, VibeFilter> = {
  chill: {
    anyGenres: ['Casual', 'Simulation', 'Indie', 'Adventure', 'Sports', 'Racing'],
    noneGenres: ['Violent', 'Gore'],
  },
  competitive: {
    anyCategories: ['PvP', 'Online PvP'],
    anyGenres: ['Action', 'Sports', 'Strategy', 'Racing'],
  },
  co_op_story: {
    anyCategories: ['Co-op', 'Online Co-op'],
    anyGenres: ['Adventure', 'RPG', 'Action'],
  },
  chaos: {
    anyGenres: ['Casual', 'Action', 'Indie', 'Party'],
  },
  sweaty: {
    anyGenres: ['Action', 'Strategy', 'Simulation', 'Sports'],
    anyCategories: ['Online PvP', 'PvP'],
  },
  // These three are about how the group wants to feel, not what genre it is,
  // so they narrow nothing. They are still captured because they change what a
  // human picks from the shortlist.
  something_new: {},
  old_favorite: {},
  low_mic: {
    noneGenres: ['Massively Multiplayer'],
  },
};

export interface GameFacts {
  genres: readonly string[];
  categories: readonly string[];
}

/** Does this game suit the vibe? A vibe with no filters suits everything. */
export function matchesVibe(game: GameFacts, vibe: VibeTag): boolean {
  const filter = VIBE_FILTERS[vibe];

  if (filter.noneGenres?.some((genre) => game.genres.includes(genre))) return false;

  const wants = [...(filter.anyGenres ?? []), ...(filter.anyCategories ?? [])];
  if (wants.length === 0) return true;

  return (
    (filter.anyGenres?.some((genre) => game.genres.includes(genre)) ?? false) ||
    (filter.anyCategories?.some((category) => game.categories.includes(category)) ?? false)
  );
}

/**
 * How well a game fits the week's mood: the share of the group's chosen vibes
 * it satisfies, weighted by how many people picked each.
 *
 * Returns 0 when it suits none of them, so callers can drop it entirely.
 */
export function vibeScore(
  game: GameFacts,
  weightedVibes: ReadonlyArray<{ tag: VibeTag; count: number }>,
): number {
  if (weightedVibes.length === 0) return 1;

  let matched = 0;
  let total = 0;
  for (const vibe of weightedVibes) {
    total += vibe.count;
    if (matchesVibe(game, vibe.tag)) matched += vibe.count;
  }
  return total === 0 ? 1 : matched / total;
}
