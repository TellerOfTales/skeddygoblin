import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../../services/context.js';
import { resolveActor } from '../../services/membershipService.js';
import { currentWeek } from '../../services/responseService.js';
import { buildOverlapReport } from '../../services/overlapService.js';
import { leaderboardView } from '../views/leaderboard.view.js';

export const data = new SlashCommandBuilder()
  .setName('overlap')
  .setDescription('Show the best windows for the group this week')
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
  const report = await buildOverlapReport(ctx, { groupId: actor.group.id, weekStartDate: week });

  const view = leaderboardView({
    groupId: actor.group.id,
    groupName: actor.group.name,
    weekStartDate: report.weekStartDate,
    windows: report.windows,
    responded: report.responded,
    total: report.total,
    topVibes: report.topVibes,
    suppressedForPrivacy: report.suppressedForPrivacy,
    // Only an organizer can turn a window into a session, so only they see the
    // buttons - and the handler re-checks, because a button is not a permission.
    showLockIn: actor.role === 'organizer',
  });

  await interaction.editReply(view);
}
