/**
 * Matching the group's shared library to the week's mood.
 *
 * The privacy rule applies here exactly as it does to availability: a game
 * carries an OWNER COUNT and never an owner list. "6 of you own this" is an
 * aggregate; "Bob owns this" is a raw disclosure about Bob's library.
 */

import { GAMES_PAGE_SIZE, MIN_AGGREGATE_HEADCOUNT, type VibeTag } from '../domain/constants.js';
import { DomainError } from '../domain/errors.js';
import { matchedVibes, vibeScore } from '../domain/gameMatching.js';
import { searchStore } from '../steam/clients.js';
import * as gameVotes from '../db/repositories/gameVotes.js';
import * as steam from '../db/repositories/steam.js';
import * as vibes from '../db/repositories/vibes.js';
import type { SharedGame } from '../db/repositories/steam.js';
import type { GroupId, UserId } from '../db/repositories/types.js';
import type { IsoDate } from '../domain/week.js';
import type { AppContext } from './context.js';

export interface SuggestedGame extends SharedGame {
  /** 0-1: the share of the week's vibe picks this game satisfies. */
  vibeFit: number;
  /** Which of the week's vibes it satisfies, so the pick can explain itself. */
  matchedVibes: VibeTag[];
}

/**
 * Games this week's players share, ranked by how well they fit the mood.
 *
 * Ordering puts vibe fit first and owner count second: a game four people own
 * and everyone is in the mood for beats one six people own and nobody fancies.
 * Owner count still breaks ties, and both are aggregates.
 */
export interface SuggestionPage {
  games: SuggestedGame[];
  page: number;
  totalPages: number;
  total: number;
}

/**
 * One page of suggestions.
 *
 * Paged rather than truncated because a group with a big shared library has a
 * long tail worth browsing - the top five are the best fit for the stated mood,
 * but "show me more" is a reasonable thing to want and cheap to serve from an
 * already-computed list.
 */
export async function suggestGamesPage(
  ctx: AppContext,
  params: {
    groupId: GroupId;
    weekStartDate: IsoDate;
    page?: number;
    pageSize?: number;
    multiplayerOnly?: boolean;
  },
): Promise<SuggestionPage> {
  const pageSize = params.pageSize ?? GAMES_PAGE_SIZE;
  const all = await suggestGames(ctx, {
    groupId: params.groupId,
    weekStartDate: params.weekStartDate,
    limit: Number.MAX_SAFE_INTEGER,
    ...(params.multiplayerOnly === undefined ? {} : { multiplayerOnly: params.multiplayerOnly }),
  });

  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const page = Math.min(Math.max(params.page ?? 0, 0), totalPages - 1);

  return {
    games: all.slice(page * pageSize, page * pageSize + pageSize),
    page,
    totalPages,
    total: all.length,
  };
}

export async function suggestGames(
  ctx: AppContext,
  params: {
    groupId: GroupId;
    weekStartDate: IsoDate;
    limit?: number;
    multiplayerOnly?: boolean;
  },
): Promise<SuggestedGame[]> {
  const scope = { groupId: params.groupId, weekStartDate: params.weekStartDate };

  const shared = await steam.listSharedGamesAggregate(ctx.db, {
    ...scope,
    minOwners: MIN_AGGREGATE_HEADCOUNT,
    multiplayerOnly: params.multiplayerOnly ?? true,
    limit: 200,
  });
  const weekVibes = await vibes.countVibesAggregate(ctx.db, scope);

  return shared
    .map((game) => ({
      ...game,
      vibeFit: vibeScore(game, weekVibes),
      matchedVibes: matchedVibes(game, weekVibes),
    }))
    .filter((game) => game.vibeFit > 0)
    .sort(
      (a, b) =>
        b.vibeFit - a.vibeFit ||
        b.ownerCount - a.ownerCount ||
        a.name.localeCompare(b.name) ||
        a.appId - b.appId,
    )
    .slice(0, params.limit ?? 5);
}

/**
 * Candidates for /propose autocomplete.
 *
 * Sourced from the shared library so the sanctioned free-text input is still,
 * in practice, a pick from a list.
 */
export async function searchSharedGames(
  ctx: AppContext,
  params: { groupId: GroupId; weekStartDate: IsoDate; query: string; limit?: number },
): Promise<SharedGame[]> {
  const shared = await steam.listSharedGamesAggregate(ctx.db, {
    groupId: params.groupId,
    weekStartDate: params.weekStartDate,
    minOwners: MIN_AGGREGATE_HEADCOUNT,
    multiplayerOnly: true,
    limit: 200,
  });

  const needle = params.query.trim().toLowerCase();
  const matches = needle
    ? shared.filter((game) => game.name.toLowerCase().includes(needle))
    : shared;

  return matches.slice(0, params.limit ?? 25);
}

export interface GameOption {
  voteId: number;
  appId: number | null;
  gameName: string;
  votes: number;
  /** Whether the viewing member has voted for this option. Self-scoped. */
  votedByMe: boolean;
  /** From the shared metadata cache, so the shortlist shows what it costs. */
  priceCents: number | null;
  priceCentsUsd: number | null;
  currency: string | null;
  storeUrl: string | null;
}

export interface ResolvedGame {
  name: string;
  appId: number | null;
  priceCents: number | null;
  priceCentsUsd: number | null;
  currency: string | null;
  storeUrl: string | null;
}

/**
 * Turns whatever someone typed into a real Steam game with a real price.
 *
 * Tries the group's shared library first, since that is both cheaper and more
 * likely to be what they meant. Falls back to the Steam store, which is what
 * makes nominating something NOBODY owns useful: the group immediately sees
 * what it would cost them, in their own currency.
 *
 * Returns the raw name unresolved rather than failing if Steam has nothing -
 * "we could play the new one when it's out" is a legitimate nomination.
 */
export async function resolveNomination(
  ctx: AppContext,
  params: { groupId: GroupId; weekStartDate: IsoDate; countryCode: string; query: string },
): Promise<ResolvedGame> {
  const query = params.query.trim();

  const owned = await searchSharedGames(ctx, {
    groupId: params.groupId,
    weekStartDate: params.weekStartDate,
    query,
    limit: 5,
  });
  const exactOwned = owned.find((game) => game.name.toLowerCase() === query.toLowerCase());
  if (exactOwned) {
    return {
      name: exactOwned.name,
      appId: exactOwned.appId,
      priceCents: exactOwned.priceCents,
      priceCentsUsd: exactOwned.priceCentsUsd,
      currency: exactOwned.currency,
      storeUrl: exactOwned.storeUrl,
    };
  }

  try {
    const results = await searchStore({
      term: query,
      countryCode: params.countryCode,
      limit: 5,
    });
    const best =
      results.find((game) => game.name.toLowerCase() === query.toLowerCase()) ?? results[0];

    if (best) {
      // Cache what we learned, so the next person asking costs nothing.
      await steam.upsertAppMeta(ctx.db, {
        appId: best.appId,
        name: best.name,
        categories: [],
        genres: [],
        multiplayer: false,
        priceCents: best.priceCents,
        currency: best.currency,
        priceCountry: params.countryCode.toUpperCase(),
        // storesearch prices one storefront per call; the reference price is
        // filled in by the metadata refresh rather than by a second search.
        priceCentsUsd: params.countryCode.toUpperCase() === 'US' ? best.priceCents : null,
        storeUrl: best.storeUrl,
      });

      return {
        name: best.name,
        appId: best.appId,
        priceCents: best.priceCents,
        priceCentsUsd: params.countryCode.toUpperCase() === 'US' ? best.priceCents : null,
        currency: best.currency,
        storeUrl: best.storeUrl,
      };
    }
  } catch (error) {
    // A nomination should never fail because Steam is having a moment.
    ctx.logger.warn('store search failed, nominating unresolved', { query, error });
  }

  return {
    name: query,
    appId: null,
    priceCents: null,
    priceCentsUsd: null,
    currency: null,
    storeUrl: null,
  };
}

export async function nominateGame(
  ctx: AppContext,
  params: {
    proposalId: number;
    gameName: string;
    appId?: number | null;
    nominatedBy: UserId;
  },
): Promise<number> {
  const vote = await gameVotes.createGameVote(ctx.db, {
    proposalId: params.proposalId,
    gameName: params.gameName,
    appId: params.appId ?? null,
    nominatedBy: params.nominatedBy,
  });
  // Nominating is voting - it would be odd to propose something and then have
  // to vote for it separately.
  await gameVotes.castVote(ctx.db, vote.id, params.nominatedBy);
  return vote.id;
}

export async function toggleVote(
  ctx: AppContext,
  params: { voteId: number; userId: UserId },
): Promise<boolean> {
  return gameVotes.toggleVote(ctx.db, params.voteId, params.userId);
}

export async function requireGameVote(ctx: AppContext, voteId: number) {
  const vote = await gameVotes.findGameVoteById(ctx.db, voteId);
  if (!vote) throw new DomainError('PROPOSAL_NOT_FOUND', 'That nomination no longer exists');
  return vote;
}

export async function listGameOptions(
  ctx: AppContext,
  params: { proposalId: number; viewerUserId: UserId },
): Promise<GameOption[]> {
  return gameVotes.listOptionsAggregate(ctx.db, params.proposalId, params.viewerUserId);
}

/**
 * How many members still need to link Steam, as counts only.
 *
 * Surfaced on the public board so the group can see WHY the games section is
 * thin, without naming anyone for not having got round to it yet.
 */
export async function countUnlinkedMembers(
  ctx: AppContext,
  groupId: GroupId,
): Promise<{ unlinked: number; total: number }> {
  return steam.countUnlinkedMembersAggregate(ctx.db, groupId);
}
