import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { resolveActor } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import { buildRoster } from '../../services/rosterService.js';
import { rosterView } from '../views/roster.view.js';

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription("See who's answered this week, and nudge whoever hasn't")
  .setDMPermission(false);

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
  const roster = await buildRoster(ctx, { group: actor.group, weekStartDate: week });

  await interaction.editReply(
    rosterView({
      groupId: actor.group.id,
      groupName: actor.group.name,
      weekStartDate: roster.weekStartDate,
      rows: roster.rows,
      responded: roster.responded,
      total: roster.total,
    }),
  );
}
