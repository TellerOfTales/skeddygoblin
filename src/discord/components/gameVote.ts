/**
 * Voting on nominated games. A tap toggles - voting twice removes your vote.
 */

import { DomainError } from '../../domain/errors.js';
import { fromBase36, type ParsedCustomId } from '../customId.js';
import type { ComponentInteraction } from './index.js';
import { registerComponentHandler } from './index.js';
import type { AppContext } from '../../services/context.js';
import { resolveMemberByDiscordId } from '../../services/membershipService.js';
import {
  listGameOptions,
  requireGameVote,
  suggestGamesPage,
  toggleVote,
} from '../../services/gameService.js';
import { requireProposal } from '../../services/sessionService.js';
import { currentWeek } from '../../services/responseService.js';
import { gameSuggestionsView, gameVoteView } from '../views/games.view.js';

async function handleVote(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  const voteArg = parsed.args[0];
  if (voteArg === undefined) throw new DomainError('INVALID_INPUT');

  const voteId = fromBase36(voteArg);
  const vote = await requireGameVote(ctx, voteId);
  const proposal = await requireProposal(ctx, vote.proposalId);

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId: proposal.groupId,
  });

  await interaction.deferUpdate();
  await toggleVote(ctx, { voteId, userId: actor.user.id });

  await interaction.editReply(
    gameVoteView({
      proposalId: proposal.id,
      day: proposal.candidateDay,
      window: proposal.candidateWindow,
      options: await listGameOptions(ctx, {
        proposalId: proposal.id,
        viewerUserId: actor.user.id,
      }),
    }),
  );
}

async function handlePage(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  const [groupArg, pageArg, soloArg] = parsed.args;
  if (groupArg === undefined) throw new DomainError('INVALID_INPUT');

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId: fromBase36(groupArg),
  });

  await interaction.deferUpdate();

  const multiplayerOnly = soloArg !== '1';
  const page = await suggestGamesPage(ctx, {
    groupId: actor.group.id,
    weekStartDate: currentWeek(ctx, actor.group.timezone),
    page: Number(pageArg ?? 0),
    multiplayerOnly,
  });

  await interaction.editReply(
    gameSuggestionsView({
      groupId: actor.group.id,
      groupName: actor.group.name,
      suggestions: page.games,
      page: page.page,
      totalPages: page.totalPages,
      total: page.total,
      multiplayerOnly,
    }),
  );
}

async function handle(
  interaction: ComponentInteraction,
  parsed: ParsedCustomId,
  ctx: AppContext,
): Promise<void> {
  switch (parsed.action) {
    case 'vote':
      return handleVote(interaction, ctx, parsed);
    case 'page':
      return handlePage(interaction, ctx, parsed);
    default:
      ctx.logger.warn('unknown game vote action', { action: parsed.action });
  }
}

registerComponentHandler('gv', handle);
