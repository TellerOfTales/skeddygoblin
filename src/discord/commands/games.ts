import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { resolveActor } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import { suggestGames } from '../../services/gameService.js';
import { steamEnabled } from '../../services/steamService.js';
import { gameSuggestionsView } from '../views/games.view.js';

export const data = new SlashCommandBuilder()
  .setName('games')
  .setDescription('What could we all actually play this week?')
  .setDMPermission(false)
  .addBooleanOption((option) =>
    option
      .setName('include_solo')
      .setDescription('Include games without multiplayer (default: no)')
      .setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!steamEnabled()) {
    await interaction.editReply(
      'Steam is not configured on this deployment yet, so there is no shared library to search.',
    );
    return;
  }

  if (!interaction.guildId) {
    await interaction.editReply('Run this in a server, not a DM.');
    return;
  }

  const actor = await resolveActor(ctx, {
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId,
    guildName: interaction.guild?.name ?? 'this server',
  });

  const suggestions = await suggestGames(ctx, {
    groupId: actor.group.id,
    weekStartDate: currentWeek(ctx, actor.group.timezone),
    multiplayerOnly: !(interaction.options.getBoolean('include_solo') ?? false),
  });

  await interaction.editReply(gameSuggestionsView({ groupName: actor.group.name, suggestions }));
}
