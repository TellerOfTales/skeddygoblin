/**
 * Matching the group's shared library to the week's mood. Pure.
 *
 * ---------------------------------------------------------------------------
 * A VIBE IS A STEAM TERM
 * ---------------------------------------------------------------------------
 * Vibe tags are exact values from Steam's own `genres` and `categories` lists,
 * so matching is plain membership: does this game carry the tag the group
 * picked? There is no translation table between what a member chose and what
 * they get suggested, because a translation table is guesswork sitting in the
 * worst possible place.
 *
 * Worth knowing: Steam's USER tags - "Relaxing", "Story Rich", "Souls-like" -
 * are NOT returned by the official appdetails endpoint. Only `genres` and
 * `categories` are. Every value below comes from those two lists, so each one
 * can actually be matched against real API data rather than scraped off a store
 * page that will change shape without warning.
 */

import type { VibeTag } from './constants.js';

/**
 * Steam store categories that mean "you can play this together".
 *
 * Matched by display name rather than id: the ids are undocumented and have
 * shifted historically, whereas these strings have been stable for years.
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

export interface GameFacts {
  genres: readonly string[];
  categories: readonly string[];
}

/**
 * Does this game carry the vibe? Exact membership, no interpretation.
 *
 * Some Steam categories nest: a game tagged only "Online Co-op" is obviously
 * Co-op, and one tagged only "Online PvP" is obviously PvP. Those two
 * broadenings are the single concession to Steam's own inconsistency, and they
 * are listed explicitly rather than inferred.
 */
const IMPLIED_BY: Partial<Record<VibeTag, string[]>> = {
  'Co-op': ['Online Co-op', 'Shared/Split Screen Co-op', 'LAN Co-op'],
  'Online PvP': ['PvP', 'Shared/Split Screen PvP', 'LAN PvP'],
};

export function matchesVibe(game: GameFacts, vibe: VibeTag): boolean {
  const accepted = [vibe, ...(IMPLIED_BY[vibe] ?? [])];
  return accepted.some((term) => game.genres.includes(term) || game.categories.includes(term));
}

/**
 * How well a game fits the week's mood: the share of the group's vibe picks it
 * satisfies, weighted by how many people chose each.
 *
 * Returns 0 when it suits none of them, so callers can drop it entirely, and 1
 * when nobody expressed a preference - no opinion is not the same as no match.
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

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Formats a Steam price for display.
 *
 * Steam reports prices in the storefront's minor units together with an ISO
 * currency code, so the group's country determines both the number AND the
 * symbol. Intl does the rest, which means a UK group sees £ and a Japanese one
 * sees a yen amount with no decimals - without a hand-maintained symbol table.
 */
export function formatPrice(
  minorUnits: number | null,
  currency: string | null,
  locale = 'en-GB',
): string | null {
  if (minorUnits === null) return null;
  if (minorUnits === 0) return 'Free';
  if (!currency) return (minorUnits / 100).toFixed(2);

  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minorUnits / 100);
  } catch {
    // An unrecognised currency code should not take a message down.
    return `${(minorUnits / 100).toFixed(2)} ${currency}`;
  }
}
