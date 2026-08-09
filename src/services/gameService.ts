/**
 * Matching the group's shared library to the week's mood.
 *
 * The privacy rule applies here exactly as it does to availability: a game
 * carries an OWNER COUNT and never an owner list. "6 of you own this" is an
 * aggregate; "Bob owns this" is a raw disclosure about Bob's library.
 */

import { MIN_AGGREGATE_HEADCOUNT } from '../domain/constants.js';
import { DomainError } from '../domain/errors.js';
import { vibeScore } from '../domain/gameMatching.js';
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
}

/**
 * Games this week's players share, ranked by how well they fit the mood.
 *
 * Ordering puts vibe fit first and owner count second: a game four people own
 * and everyone is in the mood for beats one six people own and nobody fancies.
 * Owner count still breaks ties, and both are aggregates.
 */
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
    .map((game) => ({ ...game, vibeFit: vibeScore(game, weekVibes) }))
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
