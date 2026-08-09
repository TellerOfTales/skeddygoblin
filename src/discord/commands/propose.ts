import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { resolveActor } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import { listGameOptions, nominateGame, searchSharedGames } from '../../services/gameService.js';
import { listOpenProposals, requireProposal } from '../../services/sessionService.js';
import { gameVoteView } from '../views/games.view.js';

/**
 * The one sanctioned free-text input in the product - and even it is
 * autocompleted from the group's shared library, so the common path is still a
 * pick rather than a type.
 */
export const data = new SlashCommandBuilder()
  .setName('propose')
  .setDescription('Nominate a game for an upcoming session')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('game')
      .setDescription('Start typing — suggestions come from games your group shares')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(120),
  )
  .addIntegerOption((option) =>
    option
      .setName('session')
      .setDescription('Session id, if the group has more than one going')
      .setRequired(false),
  );

export async function autocomplete(
  interaction: AutocompleteInteraction,
  ctx: AppContext,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const actor = await resolveActor(ctx, {
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId,
    guildName: interaction.guild?.name ?? 'this server',
  });

  const games = await searchSharedGames(ctx, {
    groupId: actor.group.id,
    weekStartDate: currentWeek(ctx, actor.group.timezone),
    query: interaction.options.getFocused(),
    limit: 25,
  });

  await interaction.respond(
    games.map((game) => ({
      // The owner count is aggregate, so it is safe to show - and it is the
      // most useful thing to know when picking.
      name: `${game.name} · ${game.ownerCount} own it`.slice(0, 100),
      value: game.name.slice(0, 100),
    })),
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guildId) {
    await interaction.editReply('Run this in a server, not a DM.');
    return;
  }

  const actor = await resolveActor(ctx, {
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId,
    guildName: interaction.guild?.name ?? 'this server',
  });
  const week = currentWeek(ctx, actor.group.timezone);

  const gameName = interaction.options.getString('game', true).trim();
  if (gameName.length === 0) {
    await interaction.editReply('Give the game a name.');
    return;
  }

  const sessionId = interaction.options.getInteger('session');
  const proposal = sessionId
    ? await requireProposal(ctx, sessionId)
    : await findDefaultProposal(ctx, actor.group.id, week);

  if (!proposal) {
    await interaction.editReply(
      'There is no session to nominate for yet. An organizer can lock one in from `/overlap`.',
    );
    return;
  }

  // Match the nomination back to a known app where possible, so the vote can
  // carry a store link and price.
  const candidates = await searchSharedGames(ctx, {
    groupId: actor.group.id,
    weekStartDate: week,
    query: gameName,
    limit: 5,
  });
  const matched = candidates.find((game) => game.name.toLowerCase() === gameName.toLowerCase());

  await nominateGame(ctx, {
    proposalId: proposal.id,
    gameName: matched?.name ?? gameName,
    appId: matched?.appId ?? null,
    nominatedBy: actor.user.id,
  });

  const options = await listGameOptions(ctx, {
    proposalId: proposal.id,
    viewerUserId: actor.user.id,
  });

  await interaction.editReply(
    gameVoteView({
      proposalId: proposal.id,
      day: proposal.candidateDay,
      window: proposal.candidateWindow,
      options,
    }),
  );
}

/**
 * The session to nominate for when none was named.
 *
 * Takes the earliest open one. If a group has several going at once they can
 * disambiguate with the `session` option; guessing harder than this would be
 * guessing wrong more confidently.
 */
async function findDefaultProposal(ctx: AppContext, groupId: number, week: string) {
  const open = await listOpenProposals(ctx, { groupId, weekStartDate: week });
  return open[0] ?? null;
}
